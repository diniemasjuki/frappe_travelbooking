// travel_booking/module_admin_portal/page/travel_manager/tm_booking_view.js
// BOOKING ORDER VIEW — page maklumat SATU booking order (L3), INDEPENDEN
// daripada direktori pemanggil.
//
// [Nov 2026] Dipindah keluar daripada tm_booking.js (blok L3) menjadi
// sub-pakej sendiri — corak traveller_list.js / rooms_list.js /
// rooming_board.js: di-include DALAM IIFE BookingManagement oleh
// render_include (concatenation server-side), jadi helper kongsi IIFE
// (api, badge, fmtMoney, S, show_booking …) terus boleh dipakai.
//
// KONSEP "DIREKTORI" (konteks panggilan): view ini boleh dibuka dari
// MANA-MANA seksyen — setiap pemanggil membawa KONTEKS DIREKTORI
// (butang kembali, senarai rakan setara untuk Prev/Next) dan view TIDAK
// menukar direktori pemanggil:
//
//   travel-manager/booking/<BK>                      senarai flat Booking
//   travel-manager/booking-group/<BK>                root Booking Group
//   travel-manager/booking-group/group/<G>/<BK>      detail group (L2)
//   travel-manager/booking-group/batch/<B>/<BK>      detail batch (L2)
//   travel-manager/customer/<C>/<BK>                 direktori Customer
//
// Definisi host (URL → konteks) didaftar dalam shell travel_manager.js
// (BOOKING_VIEW_HOSTS); setiap host membekalkan fungsi konteks dari fail
// seksyen masing-masing. Pintu masuk tunggal: show_booking(name, ctx).
//
// KANDUNGAN PAGE BOOKING ORDER (turutan atas ke bawah):
//   1. Toolbar — [← kembali ke direktori] · [‹ Prev] n / N [Next ›] ·
//      [Payment Request Link] [Submit Payment Entry (n)] [Actions ▾]
//      (semua butang pindaan order — Edit Pax, Roommate Match,
//      Reschedule, Open Booking Form — dikumpulkan dalam Actions).
//   2. Rail konteks (identiti, customer, trip & stay, sales & channel).
//   3. Tab — Overview / Travellers / Rooms / Documents / Add-ons &
//      Flights / Others.
	/* ========== L3: BOOKING INFO (route /booking/<name>) ========== */

	const bkg_pe_rows = (d) => {
		const map = {};
		(d.transactions?.payments || []).forEach((pe) => {
			const e = map[pe.name] || (map[pe.name] = {
				name: pe.name,
				date: pe.reference_date || (pe.creation || '').slice(0, 10),
				docstatus: pe.docstatus,
				amounts: {},
			});
			e.amounts[pe.currency] = round2((e.amounts[pe.currency] || 0) + pe.allocated_amount);
		});
		return Object.values(map).sort((a, b) => String(b.date).localeCompare(String(a.date)));
	};

	const bkg_discount = (p) => {
		const cur = p.discount_currency || S.currency;
		const total = round2((p.voucher_discount || 0) + (p.price_rule_discount || 0) + (p.referral_discount || 0));
		const parts = [];
		if (p.voucher_discount) parts.push('V: ' + fmtMoney(p.voucher_discount, cur));
		if (p.price_rule_discount) parts.push('PR: ' + fmtMoney(p.price_rule_discount, cur));
		if (p.referral_discount) parts.push('RF: ' + fmtMoney(p.referral_discount, cur));
		return { cur, total, parts };
	};

	function render_booking(key, d) {
		const st = S.state[key] || (S.state[key] = default_state());
		st.tab = BKG_TABS.some((t) => t.id === st.tab) ? st.tab : 'ov';
		const p = d.profile || {};
		const resCount = (d.reservations || []).length;
		const peCount = bkg_pe_rows(d).length;
		const docCount = (d.documents?.sales_orders || []).length
			+ (d.documents?.sales_invoices || []).length
			+ (d.documents?.proforma_invoices || []).length;

		// Notifikasi onload — mesej customer terus dipaparkan sebagai modal.
		if (p.customer_message) {
			frappe.msgprint({
				title: '💬 ' + __('Customer Message') + ' — ' + (p.booking_number || p.name),
				indicator: 'yellow',
				message: `<div class="mba-msg-body">${esc(p.customer_message)}</div>`,
			});
		}

		$('#mba-detail').html(`
			<div class="mba-group mba-bkg" data-item="${esc(key)}">
				${bkg_toolbar(p, d)}
				<div class="mba-bkg-shell">
					<aside class="mba-bkg-rail">${bkg_rail(p, d)}</aside>
					<div class="mba-bkg-main">
						<div class="mba-tabs">
							${BKG_TABS.map((t) => `
								<button class="mba-tab ${st.tab === t.id ? 'active' : ''}" data-tab="${t.id}">${t.label}
									${t.id === 'tv' && resCount ? `<span class="mba-count-pill">${resCount}</span>` : ''}
									${t.id === 'rm' ? `<span class="mba-count-pill" data-rm-pill style="display:none"></span>` : ''}
									${t.id === 'doc' && (docCount + peCount) ? `<span class="mba-count-pill">${docCount + peCount}</span>` : ''}
									${t.id === 'af' ? `<span class="mba-count-pill" data-af-pill style="display:none"></span>` : ''}
								</button>`).join('')}
						</div>
						<div class="mba-tab-panes">
							<div class="mba-tab-pane ${st.tab === 'ov' ? 'active' : ''}" data-pane="ov"></div>
							<div class="mba-tab-pane ${st.tab === 'tv' ? 'active' : ''}" data-pane="tv"></div>
							<div class="mba-tab-pane ${st.tab === 'rm' ? 'active' : ''}" data-pane="rm"></div>
							<div class="mba-tab-pane ${st.tab === 'doc' ? 'active' : ''}" data-pane="doc"></div>
							<div class="mba-tab-pane ${st.tab === 'af' ? 'active' : ''}" data-pane="af"></div>
							<div class="mba-tab-pane ${st.tab === 'other' ? 'active' : ''}" data-pane="other"></div>
						</div>
					</div>
				</div>
			</div>`);

		// Profail di-fetch semula setiap lawatan — kosongkan cache bilik
		// supaya tab Rooms L3 tidak kekal lapuk (cth. selepas susun atur
		// di Rooming Board dalam sesi SPA yang sama).
		delete (S.cache[key] || {}).bkgrooms;
		S.cache[key] = { ...(S.cache[key] || {}), profile: d };
		wire_bkg_toolbar(key, p);
		render_bkg_overview(key);
		// Tab Travellers L3 — sumber disatukan, dimuatkan lazily (bukan
		// lagi daripada profile.reservations).
		if (st.tab === 'tv') load_bkg_travellers(key);
		// Tab Rooms L3 — pakej rooming list (get_group_rooming skop
		// booking), dimuatkan lazily.
		if (st.tab === 'rm') load_bkg_rooms(key);
		// Tab Add-ons & Flights L3 — dimuatkan lazily (get_booking_addons_
		// flights), pill kiraan diisi selepas muat.
		if (st.tab === 'af') load_bkg_af(key);
		render_bkg_documents(key);
		render_bkg_others(key);
	}

	// ══ TOOLBAR & KONTEKS DIREKTORI ══
	// Butang kembali dan laluan Prev/Next datang daripada KONTEKS DIREKTORI
	// pemanggil (S.bkg_ctx — diisi show_booking(); dibina oleh host di shell
	// travel_manager.js). View ini TIDAK menentukan sendiri direktorinya,
	// jadi ia boleh dibuka dari mana-mana seksyen tanpa kehilangan direktori
	// asal.

	// Panggilan API tanpa popup ralat (nav prev/next, senarai PE) — kegagalan
	// hanya melumpuhkan butang berkenaan, bukan seluruh page.
	const bkg_api = (method, args) =>
		frappe.call({ method: 'travel_booking.api.' + method, args, quiet: true })
			.then((r) => r?.message ?? null);

	// Kebenaran submit Payment Entry — kerani tanpa hak tidak nampak butang
	// "Submit Payment Entry" (server menguatkuasakan semula).
	// Update status booking — approval Tour Manager / System Manager sahaja
	// (amalan didokumen pada kepala page; Cancelled/Abandoned menjalankan
	// cascade ke SO/PR belum bayar).
	const can_update_status = () => !!(frappe.user.has_role('Tour Manager')
		|| frappe.user.has_role('System Manager'));
	// Register Payment — cipta PE draf; ERPNext juga mementingkan kebenaran
	// BACA Account semasa validate, jadi butang hanya dipapar bila kedua-dua
	// kebenaran ada (selari semakan awal di server).
	const can_create_pe = () => !!(frappe.perm?.has_perm
		&& frappe.perm.has_perm('Payment Entry', 0, 'create')
		&& frappe.perm.has_perm('Account', 0, 'read'));

	// PE draft (docstatus 0) booking — menunggu sahkan.
	const bkg_pending_pe = (d) => bkg_pe_rows(d).filter((pe) => pe.docstatus === 0);

	// Toolbar — [← kembali ke direktori] › batch › group › BK · ‹ Prev n/N
	// Next › · [Payment Request Link] [Submit Payment Entry (n)] [Actions ▾].
	function bkg_toolbar(p, d) {
		const ctx = S.bkg_ctx || {};
		const back = ctx.back || { label: __('All Bookings'), route: ['travel-manager', 'booking'] };
		const sep = '<span class="mba-crumb-sep">›</span>';
		// Crumb batch/group — pautan silang ke direktori Booking Group;
		// dilangkau bila ia sudah sasaran butang kembali (elak gulungan).
		const isBack = (id) => id && Array.isArray(back.route)
			&& back.route[back.route.length - 1] === id;
		const crumbs = [
			`<button type="button" class="mba-crumb mba-bkg-back-btn"
				title="${esc(__('Back to {0}', [back.label]))}">← ${esc(back.label)}</button>`,
			(p.group_batch && !isBack(p.group_batch)) ? `${sep}
				<button type="button" class="mba-crumb mba-back-batch-btn" data-batch="${esc(p.group_batch)}"
					title="${esc(__('Open batch detail'))}">${esc(p.group_batch)}</button>` : '',
			(p.trip_date && !isBack(p.trip_date)) ? `${sep}
				<button type="button" class="mba-crumb mba-back-group-btn" data-group="${esc(p.trip_date)}"
					title="${esc(__('Open group detail'))}">${esc(p.trip_date)}</button>` : '',
			`${sep}<span class="mba-crumb mba-crumb--cur">${esc(p.booking_number || p.name)}</span>`,
		].join('');

		return `
			<div class="mba-bkg-topbar">
				<nav class="mba-crumbs" aria-label="${__('Breadcrumb')}">${crumbs}</nav>
				<div class="mba-bkg-nav" data-bkg-nav></div>
				<div class="mba-bkg-actions">
					${can_update_status() ? `
					<button type="button" class="btn btn-default btn-sm mba-bkg-status-btn" aria-haspopup="menu"
						title="${esc(__('Update booking status'))}">
						${frappe.utils.icon('refresh', 'xs')} ${__('Status')}: ${esc(p.status || '—')} ${frappe.utils.icon('chevron-down', 'xs')}</button>` : ''}
					<button type="button" class="btn btn-default btn-sm mba-bkg-pay-menu-btn" aria-haspopup="menu"
						title="${esc(__('Payment Entry actions — register a payment or generate a payment link'))}">
						${frappe.utils.icon('credit-card', 'xs')} ${__('Payment Entry')} ${frappe.utils.icon('chevron-down', 'xs')}</button>
					<button type="button" class="btn btn-default btn-sm mba-bkg-actions-btn"
						aria-haspopup="menu" title="${esc(__('Booking actions'))}">
						${__('Actions')} ${frappe.utils.icon('chevron-down', 'xs')}</button>
				</div>
			</div>`;
	}

	// Muat semula page booking order (profil di-fetch semula) selepas
	// tindakan yang mengubah data — tanpa bergantung pada nama route, sebab
	// view kini boleh hidup dalam mana-mana direktori.
	function reload_booking_view(name) {
		const key = 'bkg:' + name;
		if (!S.detail || S.detail.key !== key || S.mode !== 'booking') return;
		show_booking(name, S.bkg_ctx, true);
	}

	// Tukar status booking — Cancelled/Abandoned disahkan dahulu (cascade
	// membatalkan SO/PR belum bayar + lepaskan voucher); endpoint melakukan
	// doc.save() penuh supaya hook standard berjalan.
	function change_booking_status(booking, status) {
		const proceed = () => {
			frappe.call({
				method: 'travel_booking.api.booking_payments.set_booking_status',
				args: { booking, status },
			}).then((r) => {
				frappe.show_alert({
					message: __('Booking status updated to {0}', [r?.message?.status || status]),
					indicator: 'green',
				}, 5);
				reload_booking_view(booking);
			}).catch(() => {});
		};
		if (status === 'Cancelled' || status === 'Abandoned') {
			frappe.confirm(
				status === 'Cancelled'
					? __('Cancelling this booking will also cancel its unpaid Sales Orders and payment requests. Continue?')
					: __('Marking this booking as Abandoned will also cancel its unpaid Sales Orders and payment requests. Continue?'),
				proceed);
			return;
		}
		proceed();
	}

	// ── Prev/Next — rakan setara DALAM DIREKTORI PEMANGGIL ──
	//   ctx.nav.names           — turutan PAPARAN senarai (user menyusun senarai
	//                             di klien): jiran dikira di klien, terhad
	//                             kepada baris yang kelihatan (sort klien
	//                             hanya merangkumi baris yang dimuat).
	//   ctx.nav.filters + scope — server (get_booking_neighbours) guna
	//                             tapisan & turutan yang SAMA dengan senarai,
	//                             tanpa had baris (merentasi "Load more").
	// Booking tiada dalam direktori (found false) → nav disembunyikan.
	async function load_bkg_nav($nav, name, ctx) {
		if (!$nav.length || !ctx.nav) return;
		const go = (n) => {
			window.scrollTo(0, 0);
			frappe.set_route(...(ctx.route_for
				? ctx.route_for(n.name) : ['travel-manager', 'booking', n.name]));
		};
		const paint = (r) => {
			if (!$nav.closest('body').length) return;   // page sudah bertukar
			if (!r || !r.found) { $nav.html(''); return; }
			const tip = (n, last) => esc(n
				? `${n.booking_number || n.name}${n.customer_name ? ' — ' + n.customer_name : ''}`
				: last);
			const prev = r.prev, next = r.next;
			$nav.html(`
				<button type="button" class="btn btn-default btn-sm mba-bkg-prev" ${prev ? '' : 'disabled'}
					title="${tip(prev, __('First in this list'))}">‹ ${__('Prev')}</button>
				<span class="mba-nav-pos">${r.index} / ${r.total}</span>
				<button type="button" class="btn btn-default btn-sm mba-bkg-next" ${next ? '' : 'disabled'}
					title="${tip(next, __('Last in this list'))}">${__('Next')} ›</button>`);
			if (prev) $nav.find('.mba-bkg-prev').on('click', () => go(prev));
			if (next) $nav.find('.mba-bkg-next').on('click', () => go(next));
		};

		const nav = ctx.nav;
		try {
			if (nav.names && nav.names.length) {
				const i = nav.names.indexOf(name);
				paint(i < 0 ? { found: false } : {
					found: true, index: i + 1, total: nav.names.length,
					prev: i > 0 ? { name: nav.names[i - 1] } : null,
					next: i < nav.names.length - 1 ? { name: nav.names[i + 1] } : null,
				});
				return;
			}
			const args = { booking: name, scope: nav.scope || 'all', ...(nav.filters || {}) };
			if (nav.scope === 'group') {
				args.trip_groups = typeof nav.trip_groups === 'function'
					? await nav.trip_groups() : nav.trip_groups;
			}
			if (nav.scope === 'customer') args.customer = nav.customer;
			paint(await bkg_api('manage_trip_booking.get_booking_neighbours', args));
		} catch (e) {
			paint(null);   // nav gagal — butang hilang, page kekal berfungsi
		}
	}

	// Pasang handler toolbar selepas render (root baharu setiap render —
	// tiada handler pendua). Butang kembali (.mba-bkg-back-btn) diurus
	// delegated oleh bind_events() — ia dikongsi dengan keadaan ralat.
	function wire_bkg_toolbar(key, p) {
		const ctx = S.bkg_ctx || {};
		const $g = $('#mba-detail').find(`.mba-group[data-item="${key}"]`);
		if (!$g.length) return;   // root tidak wujud — tiada apa untuk dipasang

		load_bkg_nav($g.find('[data-bkg-nav]'), p.name, ctx);

		const has_due = hasBalance(p.money_by_currency || []);

		// Status ▾ — update status booking (approval TM/SM; disekat juga di
		// server). Cancelled/Abandoned disahkan dahulu oleh change_booking_status.
		const $statusBtn = $g.find('.mba-bkg-status-btn');
		if ($statusBtn.length) {
			new frappe.ui.Dropdown({
				trigger: $statusBtn,
				align: 'end',
				options: BOOKING_STATUS_OPTIONS.filter(Boolean).map((st) => ({
					label: st,
					selected: st === p.status,
					theme: (st === 'Cancelled' || st === 'Abandoned') ? 'red' : undefined,
					onclick: () => change_booking_status(p.name, st),
				})),
			});
		}

		// Payment Entry ▾ — Register Payment + Payment Request Link.
		new frappe.ui.Dropdown({
			trigger: $g.find('.mba-bkg-pay-menu-btn'),
			align: 'end',
			options: [
				{ label: __('Register Payment'), icon: 'plus',
					description: __('Record a payment received from the customer'),
					disabled: !can_create_pe() || !has_due,
					onclick: () => open_register_payment_dialog(p.name) },
				{ label: __('Payment Request Link'), icon: 'credit-card',
					description: __('Generate and share a payment link for the outstanding balance'),
					disabled: !has_due,
					onclick: () => open_payment_link_dialog(p.name) },
			],
		});

		// Actions ▾ — SEMUA butang pindaan order dikumpulkan di sini.
		new frappe.ui.Dropdown({
			trigger: $g.find('.mba-bkg-actions-btn'),
			align: 'end',
			options: [
				{ group: __('Amend Booking'), options: [
					{ label: __('Edit Pax'), icon: 'users-edit',
						description: __('Add or remove guests — changes propagate to the Sales Order'),
						onclick: () => open_edit_pax_dialog(p.name) },
					{ label: __('Roommate Match'), icon: 'users',
						description: __('Match a solo "Open Sharing" traveller with another solo guest'),
						onclick: () => open_roommate_match_dialog(p.name) },
					{ label: __('Reschedule'), icon: 'calendar-event',
						description: __('Move this booking to another departure date or package (same trip)'),
						onclick: () => open_reschedule_dialog(p.name) },
				] },
				// Kumpulan tanpa tajuk — 'group' WAJIB diisi (string kosong)
				// kerana komponen menu kenal kumpulan ikut kehadiran kunci itu;
				// tanpa nya objek ditafsir sebagai satu baris item kosong.
				{ group: '', hide_label: true, options: [
					{ label: __('Open Booking Form'), icon: 'external-link',
						href: '/app/booking/' + encodeURIComponent(p.name), target: '_blank' },
				] },
			],
		});
	}

	// ── Modal SUBMIT PAYMENT ENTRY ──
	// Customer yang membayar melalui Manual Transfer memuat naik bukti →
	// Payment Entry DRAFT ("Pending") menunggu sahkan. Modal ini menyenarai
	// PE draft booking (dengan bukti) dan submit pilihan staf — tanpa
	// meninggalkan page. Kesan submit (hook standard, sama seperti submit
	// pada borang Desk): resit di-e-mel kepada customer, pemberitahuan
	// pengesahan dihantar, status bayaran booking dikemas kini.
	function open_payment_entry_dialog(booking) {
		bkg_api('booking_payments.get_booking_payment_entries', { booking }).then((data) => {
			if (!data) {
				frappe.show_alert({ message: __('Error loading payment entries'), indicator: 'red' }, 5);
				return;
			}
			const pes = data.payment_entries || [];
			const pending = pes.filter((pe) => pe.pending);
			const history = pes.filter((pe) => !pe.pending);
			const file_btns = (files) => (files || []).map((f) => {
				const view = `<button type="button" class="mba-doc-file-btn mba-file-view-btn"
					data-url="${esc(f.file_url)}" data-name="${esc(f.file_name)}"
					data-image="${f.is_image ? 1 : 0}" title="${esc(f.file_name)} · ${esc(__('Quick view'))}">👁</button>`;
				const thumb = f.is_image
					? `<img class="mba-pe-thumb mba-pe-thumb-view" src="${esc(f.file_url)}" alt="${esc(f.file_name)}"
						data-url="${esc(f.file_url)}" data-name="${esc(f.file_name)}" loading="lazy"
						title="${esc(f.file_name)} · ${esc(__('Quick view'))}"/>` : '';
				return `${thumb}<span class="mba-doc-file-actions">${view}
					<a class="mba-doc-file-btn" href="${esc(f.file_url)}" download
						title="${esc(f.file_name)} · ${esc(__('Download attachment'))}">⬇</a></span>`;
			}).join(' ');

			const pe_rows = pending.map((pe) => `
				<div class="mba-pe" data-pe="${esc(pe.name)}">
					<label class="mba-pe-pick">
						<input type="checkbox" class="mba-pe-check" data-pe="${esc(pe.name)}" checked
							${pe.can_submit ? '' : 'disabled'}/>
						<a href="/app/payment-entry/${esc(pe.name)}" target="_blank" rel="noopener"
							title="${esc(__('Open the Payment Entry form in a new tab'))}">${esc(pe.name)}</a>
					</label>
					<div class="mba-pe-amt">${fmtMoney(pe.paid_amount, pe.currency || S.currency)}
						<span class="mba-muted">${esc(pe.currency || '')}</span></div>
					<div class="mba-pe-meta">
						${pe.posting_date ? esc(fmtDate(pe.posting_date)) : ''}
						${pe.reference_no ? ' · ' + esc(__('Ref') + ': ' + pe.reference_no) : ''}
						${pe.mode_of_payment ? ' · ' + esc(pe.mode_of_payment) : ''}
						${pe.paid_to ? ' · ' + esc(pe.paid_to) : ''}
					</div>
					<div class="mba-pe-refs">${(pe.references || []).map((r) => `
						<div class="${r.in_booking ? '' : 'is-outside'}">
							→ ${esc(r.reference_name)} · ${fmtMoney(r.allocated_amount, r.currency || pe.currency)}
							${r.in_booking ? '' : `<span class="mba-muted">(${esc(__('another booking'))})</span>`}
						</div>`).join('')}</div>
					${pe.remarks ? `<div class="mba-pe-remarks">${esc(pe.remarks)}</div>` : ''}
					${pe.files?.length ? `<div class="mba-pe-files">${file_btns(pe.files)}</div>` : ''}
				</div>`).join('');

			const history_rows = history.map((pe) => `
				<tr>
					<td><a href="/app/payment-entry/${esc(pe.name)}" target="_blank" rel="noopener">${esc(pe.name)}</a></td>
					<td>${pe.posting_date ? esc(fmtDate(pe.posting_date)) : ''}</td>
					<td class="num">${fmtMoney(pe.paid_amount, pe.currency || S.currency)}</td>
					<td>${badge(__(PE_STATUS_META[pe.docstatus]?.label || pe.docstatus),
						PE_STATUS_META[pe.docstatus]?.color || 'gray')}</td>
				</tr>`).join('');

			const dlg = new frappe.ui.Dialog({
				title: __('Submit Payment Entry') + ' — ' + (data.booking_number || booking),
				size: 'large',
				primary_action_label: __('Submit Selected'),
				primary_action: () => do_submit(),
			});
			dlg.$body.html(`
				<div class="mba-pe-dlg">
					${!data.booking_payable ? `
					<div class="mba-paylink-warn">${esc(data.booking_status)} — ${esc(__('New payments are no longer accepted for this booking.'))}</div>` : ''}
					${pending.length ? `
					<div class="mba-pe-head">${__('Awaiting verification')}
						<span class="mba-count-pill">${pending.length}</span>
						<span class="mba-mitem-s">${__('Tick the payments you have checked against the bank statement, then submit.')}</span>
					</div>
					<div class="mba-pe-list" data-pe-list>${pe_rows}</div>
					<div class="mba-mitem-s mba-pe-note">${esc(__('Submitting verifies the payment: the receipt is e-mailed to the customer, a verification notice is sent, and the booking payment status is updated.'))}</div>`
					: `<div class="mba-paylink-empty">${__('No payment entry is awaiting verification.')}</div>`}
					${history_rows.length ? `
					<div class="mba-section-title">${__('Payment history')}
						<span class="mba-count-pill">${history.length}</span></div>
					<div class="table-responsive"><table class="table table-sm mb-0 mba-pe-history">
						<thead><tr><th>${__('Payment Entry')}</th><th>${__('Date')}</th>
							<th class="num">${__('Amount')}</th><th>${__('Status')}</th></tr></thead>
						<tbody>${history_rows}</tbody></table></div>` : ''}
				</div>`);

			// Butang utama aktif bila ≥1 PE bertanda & boleh disubmit.
			const $btn = dlg.get_primary_btn();
			const $checks = () => dlg.$body.find('.mba-pe-check:not(:disabled)');
			const sync = () => $btn.prop('disabled',
				!data.booking_payable || !$checks().filter(':checked').length);
			dlg.$body.on('change', '.mba-pe-check', sync);
			// Thumb bukti yang failnya tiada lagi di pelayar (lampiran lapuk) —
			// ganti dengan chip "fail tidak dijumpai", bukan imej pecah.
			dlg.$body.find('.mba-pe-thumb').on('error', function () {
				$(this).replaceWith(`<span class="mba-pe-file-missing"
					title="${esc(__('The attachment file is no longer on the server'))}">${esc(__('File not found'))}</span>`);
			});
			// Dialog berada di luar #mba-detail — pasang sendiri quick view
			// lampiran (thumb imej & butang 👁).
			const open_file = function (ev) {
				ev.preventDefault();
				show_file_viewer(String($(this).data('name')), String($(this).data('url')),
					$(this).data('image') == 1);
			};
			dlg.$body.on('click', '.mba-pe-thumb-view, .mba-file-view-btn', open_file);
			sync();
			dlg.show();

			function do_submit() {
				const names = $checks().filter(':checked').map(function () {
					return String($(this).data('pe'));
				}).get();
				if (!names.length) return;
				$btn.prop('disabled', true);
				frappe.call({
					method: 'travel_booking.api.booking_payments.submit_booking_payment_entries',
					args: { booking, payment_entries: names },
				}).then((r) => {
					const out = r?.message || {};
					const n = (out.submitted || []).length;
					dlg.hide();
					if (n) {
						frappe.show_alert({
							message: __('Payment entries verified: {0}', [n]),
							indicator: 'green',
						}, 5);
					}
					if ((out.failed || []).length) {
						frappe.msgprint({
							title: __('Some payment entries were not submitted'),
							indicator: 'orange',
							message: (out.failed || []).map((f) =>
								`<p class="mba-pe-fail"><b>${esc(f.name)}</b><br>${esc(f.reason)}</p>`).join(''),
						});
					}
					if (n || (out.failed || []).length) reload_booking_view(booking);
				}).catch(() => {
					// frappe.call sudah papar ralat server — benarkan cuba semula.
					$btn.prop('disabled', false);
				});
			}
		});
	}

	// Rail konteks (desktop sticky; telefon di atas kandungan) — identiti
	// + progres, customer, trip & stay, sales & channel. Audit → tab Others.
	function bkg_rail(p, d) {
		const row = (k, v) => (v ? `<div class="mba-bkg-rrow"><span class="k">${k}</span><span class="v">${v}</span></div>` : '');
		const sec = (lab, inner) => (inner && inner.trim()
			? `<div class="mba-bkg-rsec"><div class="mba-bkg-rlab">${lab}</div>${inner}</div>` : '');

		const dt = p.default_totals;
		const prog = Math.max(0, Math.min(100, Math.round(p.prog_payment || 0)));
		const progSub = dt
			? `${fmtMoney(dt.paid, dt.currency || S.currency)} / ${fmtMoney(dt.gross, dt.currency || S.currency)}`
			: '';
		const idBadges = badge(p.status, BOOKING_STATUS_COLORS[p.status]);
		const idSec = `
			<div class="mba-bkg-rsec mba-bkg-rsec--id">
				<div class="mba-bkg-idhead">
					<div class="mba-bkg-rid">${esc(p.booking_number || p.name)}</div>
					${idBadges ? `<div class="mba-bkg-rbadges">${idBadges}</div>` : ''}
				</div>
				${p.name && p.name !== p.booking_number ? `<div class="mba-cell-sub">${esc(p.name)}</div>` : ''}
				<div class="mba-bkg-pbar"><span style="width:${prog}%"></span></div>
				<div class="mba-cell-sub">${prog}% ${__('paid')}${progSub ? ' · ' + progSub : ''}</div>
			</div>`;

		const customer = p.customer
			? `<a href="/app/customer/${esc(p.customer)}">${esc(p.customer_name)}</a>`
			: esc(p.customer_name);
		const contacts = [
			p.cust_email ? `✉ ${esc(p.cust_email)}` : '',
			p.cust_phone ? `☎ ${esc(p.cust_phone)}` : '',
		].filter(Boolean).join('<br>');
		const custSec = sec(__('Customer'),
			customer + (contacts ? `<div class="mba-cell-sub">${contacts}</div>` : '')
			+ (p.customer_message ? `
			<button type="button" class="mba-bkg-msg-btn"
				data-message="${esc(p.customer_message)}"
				data-title="${esc(__('Customer Message') + ' — ' + (p.booking_number || p.name))}">
				${__('Customer Message')}
			</button>` : '')
			+ (call_wa_btns(p.cust_phone)
				? `<div class="mba-bkg-cust-actions">${call_wa_btns(p.cust_phone)}</div>` : ''));

		const tripPreview = p.trip && p.trip_published;
		const tripLabel = tripPreview
			? `<a href="/${esc((p.trip_route || 'route/' + p.trip).replace(/^\/+/, ''))}"
					class="mba-trip-preview" title="${esc(__('Trip preview from website'))}">${esc(p.trip_title || p.trip)}</a>`
			: (p.trip
				? `<a href="/app/trip/${esc(p.trip)}">${esc(p.trip_title || p.trip)}</a>`
				: esc(p.trip_title || ''));
		const groupCell = p.trip_date
			? `<a href="/app/travel-manager/booking-group/group/${esc(p.trip_date)}"
					title="${esc(__('Open group detail'))}">${p.group_batch
						? esc(p.group_batch) + ' / ' + esc(p.trip_date)
						: esc(p.trip_date)}</a>`
			: '';
		const sailLabel = (p.cruise_start || p.cruise_end)
			? fmtDate(p.cruise_start) + (p.cruise_end && p.cruise_end !== p.cruise_start ? ' → ' + fmtDate(p.cruise_end) : '')
			: '';
		const depLabel = p.departure_date
			? fmtDate(p.departure_date) + (p.return_date && p.return_date !== p.departure_date ? ' → ' + fmtDate(p.return_date) : '')
			: '';
		const datesDiffer = p.departure_date && p.cruise_start
			&& String(p.cruise_start).slice(0, 10) !== String(p.departure_date).slice(0, 10);
		const dateRows = datesDiffer
			? row(__('Departure'), esc(depLabel)) + row(__('Sail'), esc(sailLabel))
			: (p.is_a_cruise_trip && sailLabel
				? row(__('Sail'), esc(sailLabel))
				: row(__('Date'), esc(depLabel)));
		const duration = (p.total_days || p.total_night)
			? (p.total_days || '—') + ' ' + __('days') + ' / ' + (p.total_night || '—') + ' ' + __('nights')
			: '';
		const tripInner = tripLabel
			+ (p.is_a_cruise_trip || p.package_type
				? `<div class="mba-bkg-rbadges">${p.is_a_cruise_trip ? badge(__('Cruise'), 'cyan') : ''}${p.package_type ? badge(p.package_type, 'violet') : ''}</div>` : '')
			+ (groupCell ? row(__('Group'), groupCell) : '')
			+ dateRows
			+ row(__('Duration'), esc(duration))
			+ (p.booked_pax ? row(__('Booked Pax'), esc(p.booked_pax)) : '')
			+ row(__('Total Rooms'), esc(d.rooming_count ?? 0))
			+ row(__('Ship'), esc(p.ship_name));
		const tripSec = sec(__('Trip & Stay'), tripInner);

		const salesBadges = badge(p.booking_channel, 'violet') + badge(p.checkout_method, 'cyan');
		const dsc = bkg_discount(p);
		const dscRow = dsc.total > 0
			? row(__('Discount'), esc(fmtMoney(dsc.total, dsc.cur)))
				+ (dsc.parts.length ? `<div class="mba-cell-sub">${esc(dsc.parts.join(' · '))}</div>` : '')
			: '';
		const salesInner = (salesBadges ? `<div class="mba-bkg-rbadges">${salesBadges}</div>` : '')
			+ row(__('Affiliate'), esc(p.affiliate))
			+ row('B2B', esc(p.b2b_partner))
			+ row(__('End Customer'), esc(p.end_customer))
			+ row(__('Referral'), esc(p.referral_code_used))
			+ row(__('Voucher'), esc(p.voucher))
			+ dscRow;

		return idSec + custSec + tripSec + sec(__('Sales & Channel'), salesInner);
	}

	// Strip wang — Order → Paid(%) → Balance + Payment Status. Nilai utama
	// default currency; sub = pecahan native per currency. Baki tertunggak
	// memaparkan butang ikon kecil Payment Link selepas label BALANCE
	// (modal urus pautan bayaran — boleh gabungkan beberapa Sales Order
	// dalam satu pembayaran).
	function bkg_money_strip(p) {
		const rows = p.money_by_currency || [];
		const dt = p.default_totals;
		const alt = hasAltCur(rows) && dt;
		const val = (f) => (alt ? fmtDefaultTotal(dt, f) : fmtMoney((dt && dt[f]) || 0, S.currency));
		const sub = (f) => rows.map((r) => fmtMoney(r[f], r.currency)).join('<br>') || fmtMoney(0, S.currency);
		const prog = Math.max(0, Math.min(100, Math.round(p.prog_payment || 0)));
		const title = esc(__('Per currency — amounts in different currencies are never summed'));
		const payBtn = hasBalance(rows)
			? `<button type="button" class="mba-paylink-btn" data-booking="${esc(p.name)}"
					title="${esc(__('Generate and share a payment link for the outstanding balance'))}"
					aria-label="${esc(__('Payment Link'))}">${frappe.utils.icon('credit-card', 'xs')}<span>${__('Pay')}</span></button>`
			: '';

		return `
			<div class="mba-bkg-money">
				<div class="mba-mitem" title="${title}">
					<div class="mba-mitem-l">${__('Order Value')}</div>
					<div class="mba-mitem-v">${val('gross')}</div>
					<div class="mba-mitem-s">${sub('gross')}</div>
				</div>
				<span class="mba-bkg-msep">→</span>
				<div class="mba-mitem" title="${title}">
					<div class="mba-mitem-l">${__('Paid')}${prog ? ' · ' + prog + '%' : ''}</div>
					<div class="mba-mitem-v">${val('paid')}</div>
					<div class="mba-mitem-s">${sub('paid')}</div>
				</div>
				<span class="mba-bkg-msep">→</span>
				<div class="mba-mitem mba-mitem--warn" title="${title}">
					<div class="mba-mitem-l mba-mitem-l--pay">${__('Balance')}${payBtn}</div>
					<div class="mba-mitem-v">${val('balance')}</div>
					<div class="mba-mitem-s">${sub('balance')}</div>
				</div>
				<div class="mba-bkg-paystat">
					<div class="mba-mitem-l">${__('Payment Status')}</div>
					${badge(p.payment_status, PAYMENT_STATUS_COLORS[p.payment_status]) || '<span class="mba-muted">—</span>'}
				</div>
			</div>`;
	}

	// ── Fasa A (G1/G2): strip jadual bayaran (Deposit/Balance SO) + tarikh
	// akhir hold. Dipaparkan hanya bila ada baris jadual / hold aktif —
	// booking lama (pra-Fasa A) kekal tanpa blok ini. ──
	function bkg_schedule_strip(d) {
		const rows = (d.payment_schedule || []).filter((r) => r.description);
		const p = d.profile || {};
		const hold = (p.checkout_method === 'Held Booking' && p.hold_expires_on)
			? `<div class="mba-mitem mba-mitem--warn" style="min-width:150px">
					<div class="mba-mitem-l">${__('Hold Expires')}</div>
					<div class="mba-mitem-v" style="color:${new Date(p.hold_expires_on) < new Date() ? '#d93025' : 'inherit'}">
						${frappe.datetime.str_to_user(p.hold_expires_on)}</div>
					</div>` : '';
		if (!rows.length && !hold) return '';
		const sched = rows.length ? `
			<div class="mba-sched">
				<div class="mba-sched-title">${__('Payment Schedule')}</div>
				<table class="mba-sched-table">
					<thead><tr><th>${__('Term')}</th><th>${__('Due Date')}</th>
						<th class="num">${__('Amount')}</th><th class="num">${__('Outstanding')}</th></tr></thead>
					<tbody>${rows.map((r) => {
						const overdue = r.outstanding > 0.009 && r.due_date && new Date(r.due_date) < new Date();
						return `<tr class="${overdue ? 'mba-sched-overdue' : ''}">
							<td>${esc(__(r.description))}</td>
							<td>${r.due_date ? frappe.datetime.str_to_user(r.due_date) : '—'}</td>
							<td class="num">${fmtMoney(r.payment_amount, r.currency)}</td>
							<td class="num">${r.outstanding > 0.009 ? fmtMoney(r.outstanding, r.currency) : '<span class="mba-muted">✓</span>'}</td>
						</tr>`;
					}).join('')}</tbody>
				</table>
			</div>` : '';
		return `${hold ? `<div class="mba-bkg-money">${hold}</div>` : ''}${sched}`;
	}

	// ── Modal Payment Link — butang ikon kecil selepas label BALANCE (strip
	// wang). Urus pautan bayaran baki tertunggak: pilih SATU atau LEBIH
	// Sales Order (digabungkan dalam SATU pembayaran Stripe), jana pautan
	// + QR, kemudian hantar ke customer melalui WhatsApp (wa.me) / emel. ──
	const paylink_totals = (rows, amtKey, curKey) => {
		// Jumlah per currency — JANGAN jumlah merentas currency (disiplin
		// sama dengan strip wang).
		const totals = {};
		(rows || []).forEach((r) => {
			const c = r[curKey];
			totals[c] = round2((totals[c] || 0) + r[amtKey]);
		});
		return totals;
	};

	const paylink_wa_message = (d, links) => {
		const prof = ((S.cache[d.booking] || {}).profile || {}).profile || {};
		const trip = prof.trip_title || '';
		const totals = paylink_totals(links, 'amount', 'currency');
		const totalStr = Object.keys(totals).map((c) => fmtMoney(totals[c], c)).join(' + ');
		const linksBlock = links.length === 1
			? links[0].checkout_url
			: links.map((l) => l.sales_order + ' — ' + l.checkout_url).join('\n');
		return 'Hello ' + (d.customer_name || '') + ', here is the payment link for booking '
			+ (d.booking_number || d.booking) + (trip ? ' (' + trip + ')' : '') + ':\n\n'
			+ linksBlock + '\n\n'
			+ 'Amount due: ' + totalStr + '\n'
			+ links.map((l) => '- ' + l.sales_order + ': ' + fmtMoney(l.amount, l.currency)).join('\n')
			+ '\n\nYou can pay securely by card using the link above, or scan the QR code. Thank you.';
	};

	const paylink_result_html = (d) => {
		const links = d.links || [];
		if (!links.length) {
			return `<div class="mba-paylink-empty">${__('No active payment link — generate one above.')}</div>`;
		}
		const primary = links[0];
		const totals = paylink_totals(links, 'amount', 'currency');
		const totalStr = Object.keys(totals).map((c) => fmtMoney(totals[c], c)).join(' + ');
		const digits = String(d.cust_phone || '').replace(/\D/g, '');
		const waHref = digits
			? 'https://wa.me/' + (digits.startsWith('0') ? '6' + digits : digits)
				+ '?text=' + encodeURIComponent(paylink_wa_message(d, links))
			: '';
		return `
			<div class="mba-paylink-card">
				${primary.qr ? `<div class="mba-paylink-qr"><img src="${primary.qr}" alt="QR"/></div>` : ''}
				<div class="mba-paylink-info">
					<div class="mba-paylink-amt">${totalStr}</div>
					<div class="mba-mitem-s">${links.length} ${__('order(s) in this link')}</div>
					<div class="mba-paylink-urlrow">
						<input class="form-control input-sm" readonly
							value="${esc(primary.checkout_url)}"/>
						<button type="button" class="btn btn-default btn-sm mba-paylink-copy">${__('Copy')}</button>
					</div>
					<div class="mba-paylink-rows">
						${links.map((l) => `
						<div class="mba-paylink-row">
							<a href="/app/sales-order/${esc(l.sales_order)}">${esc(l.sales_order)}</a>
							<span>${fmtMoney(l.amount, l.currency)}</span>
						</div>`).join('')}
					</div>
					<div class="mba-bkg-cust-actions">
						${waHref ? `<a class="mba-quickbtn mba-quickbtn--wa" href="${esc(waHref)}"
								target="_blank" rel="noopener">${__('WhatsApp')}</a>` : ''}
						<button type="button" class="mba-quickbtn mba-paylink-email"
							${d.cust_email ? '' : 'disabled title="' + esc(__('This booking has no customer email address')) + '"'}>${__('Email')}</button>
						<a class="mba-quickbtn" href="${esc(primary.checkout_url)}"
							target="_blank" rel="noopener">${__('Open')}</a>
					</div>
					${d.cust_email ? `<div class="mba-mitem-s">${__('Email will be sent to')} ${esc(d.cust_email)}</div>` : ''}
				</div>
			</div>`;
	};

	/* ---------- Register Payment (rekod bayaran baru dari page) ---------- */
	// Staf merekod bayaran yang DITERIMA (walk-in / transfer) terus dari
	// page: cipta Payment Entry DRAFT ("Pending") ber-alokasi ke SO
	// outstanding booking — baki efektif dikira server (baki − alokasi PE
	// draf lain). Draf kemudian disahkan melalui butang "Submit Payment
	// Entry"; tiada apa-apa dihantar kepada customer sebelum itu.
	async function open_register_payment_dialog(booking) {
		const data = await bkg_api('booking_payments.get_payment_registration_context', { booking });
		if (!data) {
			frappe.show_alert({ message: __('Error loading payment data'), indicator: 'red' }, 5);
			return;
		}
		const sos = data.sos || [];
		const dlg = new frappe.ui.Dialog({
			title: __('Register Payment') + ' — ' + (data.booking_number || booking),
			size: 'large',
			primary_action_label: __('Register Payment'),
			primary_action: () => do_register(),
		});
		const so_rows = sos.map((so) => `
			<div class="mba-paylink-so" data-so="${esc(so.name)}" data-currency="${esc(so.currency)}">
				<label class="mba-paylink-sel">
					<input type="checkbox" class="mba-paylink-check" data-so="${esc(so.name)}"
						${so.effective_balance > 0.009 ? 'checked' : ''}/>
					<span class="mba-paylink-soname">${esc(so.name)}
						${so.is_addon ? badge(__('Addon Order'), 'gray') : badge(__('Sales Order'), 'blue')}
						${so.reserved > 0.009 ? `<span class="mba-mitem-s">${esc(__('Reserved by draft payments'))}: ${esc(fmtMoney(so.reserved, so.currency))}</span>` : ''}
					</span>
				</label>
				<span class="mba-paylink-amtwrap"
					title="${esc(__('Amount received for this order — up to the available balance'))}">
					<input type="number" class="mba-paylink-amt" inputmode="decimal" min="0.01"
						max="${so.effective_balance}" step="0.01" value="${so.effective_balance}"
						${so.effective_balance > 0.009 ? '' : 'disabled'}/>
					<span class="mba-paylink-cur">${esc(so.currency)}</span>
				</span>
			</div>`).join('');

		dlg.$body.html(`
			<div class="mba-reg">
				<div class="mba-mitem-s">${esc(data.customer_name || '')} · ${esc(data.company || '')}</div>
				${!data.booking_payable ? `
				<div class="mba-paylink-warn">${esc(data.booking_status)} — ${esc(__('New payments are no longer accepted for this booking.'))}</div>` : ''}
				<div class="mba-paylink-sec">
					<div class="mba-paylink-head">${__('Outstanding Orders')}</div>
					${so_rows || `<div class="mba-paylink-empty">${__('No outstanding balance on this booking.')}</div>`}
					<div class="mba-paylink-total">
						<span>${__('Amount Received')}</span>
						<b data-reg-total>—</b>
						<span class="mba-mitem-s" data-reg-count></span>
					</div>
					<div class="mba-paylink-warn" data-reg-mixed style="display:none">
						${__('Mixed currencies cannot share one Payment Entry — register them separately.')}</div>
				</div>
				<div class="mba-reg-fields">
					<label class="mba-reg-field"><span>${__('Payment Into Account')}</span>
						<select class="form-control form-control-sm mba-reg-account"></select></label>
					<label class="mba-reg-field"><span>${__('Mode of Payment')}</span>
						<select class="form-control form-control-sm mba-reg-mode"><option value=""></option>
							${(data.modes || []).map((m) => `<option value="${esc(m)}">${esc(m)}</option>`).join('')}
						</select></label>
					<label class="mba-reg-field"><span>${__('Reference No')}</span>
						<input type="text" class="form-control form-control-sm mba-reg-refno"
							placeholder="${esc(__('Bank / transaction reference'))}"/></label>
					<label class="mba-reg-field"><span>${__('Date')}</span>
						<input type="date" class="form-control form-control-sm mba-reg-date"
							value="${esc(data.today || '')}"/></label>
					<label class="mba-reg-field mba-reg-field--wide"><span>${__('Remarks')}</span>
						<input type="text" class="form-control form-control-sm mba-reg-remarks"/></label>
					<div class="mba-reg-field mba-reg-field--wide"><span>${__('Receipt Attachment')}</span>
						<div class="mba-reg-attach">
							<button type="button" class="btn btn-default btn-xs mba-reg-attach-btn"
								title="${esc(__('The file is stored privately on the Payment Entry — visible to staff only'))}">
								${frappe.utils.icon('paperclip', 'xs')} ${__('Attach receipt — JPG / PNG / PDF')}</button>
							<input type="file" class="mba-reg-file-input" multiple hidden
								accept=".jpg,.jpeg,.png,.pdf,image/jpeg,image/png,application/pdf"/>
							<div class="mba-reg-files"></div>
						</div>
					</div>
					${data.can_submit ? `
					<div class="mba-reg-field mba-reg-field--wide">
						<div class="custom-control custom-switch">
							<input type="checkbox" class="custom-control-input" id="mba-reg-submit-now">
							<label class="custom-control-label" for="mba-reg-submit-now">${__('Verify &amp; submit immediately')}
								<span class="mba-muted">— ${__('sends the receipt e-mail and verification notice')}</span></label>
						</div>
					</div>` : ''}
				</div>
				<div class="mba-mitem-s">${esc(__('The payment is saved as a draft (Pending). Verify it with "Submit Payment Entry" to post it and update the booking — nothing is sent to the customer before that.'))}</div>
			</div>`);

		const $btn = dlg.get_primary_btn();
		const $b = dlg.$body;
		// ── Lampiran bukti (resit) — dibaca sebagai data-URI dan dihantar
		// bersama register; server sahkan magic bytes & simpan sebagai File
		// PERIBADI pada PE (corak sama dengan upload bukti portal).
		const files = [];
		let reading_files = 0;
		const MAX_FILE_MB = 5;
		const render_files = () => {
			$b.find('.mba-reg-files').html(files.map((f, i) => `
				<span class="mba-reg-file-chip">
					${frappe.utils.icon('paperclip', 'xs')} ${esc(f.filename)}
					<button type="button" class="mba-reg-file-del" data-i="${i}"
						title="${esc(__('Remove this file'))}" aria-label="${esc(__('Remove this file'))}">✕</button>
				</span>`).join(''));
		};
		const refresh_accounts = (cur) => {
			const $sel = $b.find('.mba-reg-account');
			const info = cur ? (data.accounts_by_currency || {})[cur] : null;
			const opts = (info && info.options) || [];
			$sel.prop('disabled', !cur || !opts.length);
			$sel.html(opts.map((o) => `<option value="${esc(o.name)}">${esc(o.label)}</option>`).join('')
				|| `<option value="">${esc(__('— no Bank/Cash account for this currency —'))}</option>`);
			if (info && info.default) $sel.val(info.default);
			if (!$sel.val() && opts.length) $sel.val(opts[0].name);
		};
		const recompute = () => {
			const chosen = [];
			let invalid = false;
			$b.find('.mba-paylink-so').each(function () {
				const $row = $(this);
				const $chk = $row.find('.mba-paylink-check');
				const so = sos.find((x) => x.name === $chk.data('so'));
				const $amt = $row.find('.mba-paylink-amt');
				const on = $chk.prop('checked') && so && so.effective_balance > 0.009;
				$amt.prop('disabled', !on);
				if (!so || !on) { $row.removeClass('is-invalid'); return; }
				const v = parseFloat($amt.val());
				const bad = !(v > 0) || v > so.effective_balance + 0.009;
				$row.toggleClass('is-invalid', bad);
				if (bad) { invalid = true; return; }
				chosen.push({ sales_order: so.name, amount: round2(v), currency: so.currency });
			});
			const totals = {};
			chosen.forEach((c) => { totals[c.currency] = round2((totals[c.currency] || 0) + c.amount); });
			const curs = Object.keys(totals);
			$b.find('[data-reg-total]').text(
				curs.map((c) => fmtMoney(totals[c], c)).join(' + ') || '—');
			$b.find('[data-reg-count]').text(chosen.length
				? chosen.length + ' ' + __('selected') : '');
			$b.find('[data-reg-mixed]').toggle(curs.length > 1);
			refresh_accounts(curs.length === 1 ? curs[0] : null);
			$btn.prop('disabled', !data.booking_payable || !chosen.length || invalid || curs.length > 1);
			return { chosen, currency: curs[0] || null };
		};
		const do_register = () => {
			const { chosen } = recompute();
			if (!chosen.length) return;
			if (reading_files) {
				frappe.show_alert({ message: __('Still reading the attachment — try again in a second'), indicator: 'orange' }, 5);
				return;
			}
			$btn.prop('disabled', true);
			frappe.call({
				method: 'travel_booking.api.booking_payments.register_booking_payment',
				args: {
					booking,
					allocations: chosen,
					paid_to: $b.find('.mba-reg-account').val() || '',
					mode_of_payment: $b.find('.mba-reg-mode').val() || '',
					reference_no: $b.find('.mba-reg-refno').val() || '',
					reference_date: $b.find('.mba-reg-date').val() || '',
					remarks: $b.find('.mba-reg-remarks').val() || '',
					submit_now: $b.find('#mba-reg-submit-now').is(':checked') ? 1 : 0,
					attachments: files.length ? files.slice() : null,
				},
			}).then((r) => {
				const out = r?.message || {};
				dlg.hide();
				if (out.warning) {
					// PE draf kekal tersimpan — submit_now gagal (cth. deposit gate).
					frappe.msgprint({
						title: __('Payment registered but not verified'),
						indicator: 'orange',
						message: `<div class="mba-pe-fail">${esc(out.warning)}</div>`
							+ `<p class="mba-muted">${esc(__('The payment was saved as a draft — verify it via "Submit Payment Entry".'))}</p>`,
					});
				} else {
					frappe.show_alert({
						message: out.submitted
							? __('Payment {0} registered and verified', [out.name])
							: __('Payment {0} registered — awaiting verification', [out.name]),
						indicator: out.submitted ? 'green' : 'blue',
					}, 6);
				}
				reload_booking_view(booking);
			}).catch(() => $btn.prop('disabled', false));
		};

		$b.find('.mba-reg-attach-btn').on('click', () => $b.find('.mba-reg-file-input').trigger('click'));
		$b.find('.mba-reg-file-input').on('change', function () {
			for (const file of this.files) {
				if (file.size > MAX_FILE_MB * 1024 * 1024) {
					frappe.show_alert({ message: __('{0} is too large — maximum {1} MB', [file.name, MAX_FILE_MB]), indicator: 'red' }, 5);
					continue;
				}
				if (files.length + reading_files >= 5) {
					frappe.show_alert({ message: __('Maximum 5 attachments'), indicator: 'orange' }, 5);
					break;
				}
				reading_files++;
				const reader = new FileReader();
				reader.onload = () => {
					reading_files--;
					files.push({ filedata: reader.result, filename: file.name });
					render_files();
				};
				reader.onerror = () => { reading_files--; };
				reader.readAsDataURL(file);
			}
			this.value = '';
		});
		$b.on('click', '.mba-reg-file-del', function () {
			files.splice(parseInt($(this).data('i'), 10), 1);
			render_files();
		});
		dlg.$body
			.on('change', '.mba-paylink-check', recompute)
			.on('input change', '.mba-paylink-amt', recompute);
		recompute();
		dlg.show();
	}

	// ── Modal PAYMENT ENTRY — maklumat penuh PE + pratonton lampiran.
	// Footer: Submit (bila pending), buka borang doctype tab baru, muat
	// turun lampiran; resit PDF HANYA bila sudah verified (docstatus 1) —
	// tiada resit untuk PE yang masih pending.
	async function show_payment_entry_modal(booking, name) {
		const data = await bkg_api('booking_payments.get_booking_payment_entries', { booking });
		if (!data) {
			frappe.show_alert({ message: __('Error loading payment data'), indicator: 'red' }, 5);
			return;
		}
		const pe = (data.payment_entries || []).find((x) => x.name === name);
		if (!pe) {
			frappe.msgprint({ title: __('Payment Entry not found'), indicator: 'orange',
				message: __('It may have been deleted — refresh and try again.') });
			return;
		}
		const statusMeta = PE_STATUS_META[pe.docstatus] || { label: String(pe.docstatus), color: 'gray' };
		const ref_link = (r) => `/app/${r.reference_doctype === 'Sales Order' ? 'sales-order' : 'sales-invoice'}/${encodeURIComponent(r.reference_name)}`;
		const refRows = (pe.references || []).map((r) => `
			<div class="mba-pe-modal-ref">
				<span>${esc(r.reference_doctype === 'Sales Order' ? __('Sales Order') : __('Sales Invoice'))}
					${r.in_booking ? '' : `<span class="mba-muted">(${esc(__('another booking'))})</span>`}</span>
				<span><a href="${ref_link(r)}" target="_blank" rel="noopener">${esc(r.reference_name)}</a>
					· ${fmtMoney(r.allocated_amount, r.currency || pe.currency)}</span>
			</div>`).join('');
		const previews = (pe.files || []).map((f) => f.is_image
			? `<img class="mba-file-media mba-pe-attach-img" src="${esc(f.file_url)}" alt="${esc(f.file_name)}"
					title="${esc(f.file_name)}"/>`
			: `<iframe class="mba-file-frame" src="${esc(f.file_url)}" title="${esc(f.file_name)}"></iframe>`).join('')
			|| `<div class="mba-muted">${esc(__('No attachment on this payment entry.'))}</div>`;
		const dlg = new frappe.ui.Dialog({
			title: __('Payment Entry') + ' — ' + pe.name,
			size: 'large',
		});
		dlg.$body.html(`
			<div class="mba-pe-modal">
				<div class="mba-pe-modal-head">
					<div class="mba-pe-modal-amt">${fmtMoney(pe.paid_amount, pe.currency || S.currency)}
						<span class="mba-muted">${esc(pe.currency || '')}</span></div>
					<div class="mba-pe-modal-badges">${badge(__(statusMeta.label || String(pe.docstatus)), statusMeta.color)}</div>
				</div>
				<div class="mba-pe-modal-meta">
					${pe.posting_date ? `${esc(__('Date'))}: <b>${esc(fmtDate(pe.posting_date))}</b> · ` : ''}
					${pe.reference_no ? `${esc(__('Ref'))}: <b>${esc(pe.reference_no)}</b> · ` : ''}
					${pe.mode_of_payment ? `${esc(__('Mode of Payment'))}: <b>${esc(pe.mode_of_payment)}</b> · ` : ''}
					${pe.paid_to ? `${esc(__('Paid into'))}: <b>${esc(pe.paid_to)}</b>` : ''}
				</div>
				${refRows ? `<div class="mba-pe-modal-sec">${esc(__('Allocated to'))}</div>${refRows}` : ''}
				${pe.remarks ? `<div class="mba-pe-modal-sec">${esc(__('Remarks'))}</div><div class="mba-muted">${esc(pe.remarks)}</div>` : ''}
				<div class="mba-pe-modal-sec">${esc(__('Attachment Preview'))}</div>
				<div class="mba-pe-modal-preview">${previews}</div>
				<div class="mba-pe-modal-footer">
					${pe.pending && data.can_submit && data.booking_payable ? `
					<button type="button" class="btn btn-primary btn-sm mba-pe-modal-submit">
						${frappe.utils.icon('check', 'xs')} ${__('Submit (verify)')}</button>` : ''}
					<a class="btn btn-default btn-sm" href="/app/payment-entry/${esc(pe.name)}" target="_blank" rel="noopener"
						title="${esc(__('Open the Payment Entry form in a new tab'))}">
						${frappe.utils.icon('external-link', 'xs')} ${__('Open Form')}</a>
					${(pe.files || []).map((f) => `
					<a class="btn btn-default btn-sm" href="${esc(f.file_url)}" download
						title="${esc(f.file_name)} · ${esc(__('Download attachment'))}">
						${frappe.utils.icon('download', 'xs')} ${__('Download attachment')}</a>`).join('')}
					${pe.docstatus === 1 ? `
					<a class="btn btn-default btn-sm" href="${pe_receipt_url(pe.name)}" download
						title="${esc(__('Download receipt PDF'))}">
						${frappe.utils.icon('download', 'xs')} ${__('Receipt PDF')}</a>` : ''}
				</div>
			</div>`);
		dlg.$body.on('click', '.mba-pe-modal-submit', function () {
			const $btn = $(this).prop('disabled', true);
			frappe.call({
				method: 'travel_booking.api.booking_payments.submit_booking_payment_entries',
				args: { booking, payment_entries: [pe.name] },
			}).then(() => {
				dlg.hide();
				frappe.show_alert({ message: __('Payment {0} verified', [pe.name]), indicator: 'green' }, 5);
				reload_booking_view(booking);
			}).catch(() => $btn.prop('disabled', false));
		});
		// Thumbnail lampiran yang failnya tiada lagi di pelayar — ganti
		// dengan chip "fail tidak dijumpai" (corak sama dgn dialog register).
		dlg.$body.find('img.mba-pe-attach-img').each(function () {
			this.addEventListener('error', () => {
				$(this).replaceWith(`<span class="mba-pe-file-missing"
					title="${esc(__('The attachment file is no longer on the server'))}">${esc(__('File not found'))}</span>`);
			}, { once: true });
		});
		dlg.show();
	}

	/* ---------- Fasa 1c: dialog Reschedule (tukar tarikh/pakej, unpaid) ---------- */
	function open_reschedule_dialog(booking) {
		let state = null;
		let dlg = null;

		const fmt_money2 = (v, cur) => (cur || '') + ' ' + flt(v).toFixed(2);

		const selected = () => ({
			tgd: dlg.$body.find('.mba-resched-datesel').val() || '',
			pkg: dlg.$body.find('.mba-resched-pkgsel').val() || '',
		});

		const render_body = () => {
			const s = state;
			if (!s) return `<div class="text-muted">${__('Loading…')}</div>`;
			let html = '';
			if ((s.blocked || []).length) {
				html += `<div class="mba-editpax-blocked">${
					s.blocked.map((x) => `<div>⚠ ${esc(__(x))}</div>`).join('')}</div>`;
			}
			if (!(s.dates || []).length) {
				if (!(s.blocked || []).length) {
					html += `<div class="text-muted">${__('No other dates available for this trip.')}</div>`;
				}
				return html;
			}
			html += `
				<div class="mba-editpax-reason">
					<label>${__('Reason for reschedule')} <span class="text-danger">*</span></label>
					<input type="text" class="mba-editpax-reason-input form-control"
						placeholder="${esc(__('e.g. customer requested a later departure'))}" maxlength="500"/>
				</div>
				<div class="mba-editpax-row mba-editpax-catrow">
					<span>${__('Departure Date')}</span>
					<select class="form-control mba-resched-datesel" style="max-width:220px;font-size:12px;padding:3px 6px;">
						${s.dates.map((d) => `
							<option value="${esc(d.trip_group_date)}">
								${esc(frappe.datetime.str_to_user(d.departure_date))} — ${esc(d.group_name || d.trip_group_date)}
							</option>`).join('')}
					</select>
				</div>
				<div class="mba-editpax-row mba-editpax-catrow">
					<span>${__('Package')}</span>
					<select class="form-control mba-resched-pkgsel" style="max-width:260px;font-size:12px;padding:3px 6px;"></select>
					<span class="mba-resched-estimate text-muted"></span>
				</div>
				<div class="mba-editpax-row mba-editpax-catrow">
					<span></span>
					<button type="button" class="btn btn-sm btn-secondary mba-resched-confirm" disabled>
						${__('Confirm Reschedule')}</button>
					<span class="text-muted" style="font-size:11px;">${esc(__('creates a new Sales Order at current rates; the old one is cancelled'))}</span>
				</div>`;
			return html;
		};

		const render_pkgs = () => {
			const { tgd } = selected();
			const d = (state.dates || []).find((x) => x.trip_group_date === tgd);
			const $sel = dlg.$body.find('.mba-resched-pkgsel');
			const $est = dlg.$body.find('.mba-resched-estimate');
			const $btn = dlg.$body.find('.mba-resched-confirm');
			if (!d) { $sel.empty(); $est.text(''); $btn.prop('disabled', true); return; }
			$sel.html((d.packages || []).map((p) => `
				<option value="${esc(p.offer || p.package)}" data-pkg="${esc(p.package)}"
					${p.eligible ? '' : 'disabled'}
					data-est="${p.estimate_total || ''}" ${p.eligible ? '' : `title="${esc(p.reason)}"`}>
					${esc(p.package_type || p.package)}${p.eligible && p.estimate_total ? ' — ' + esc(fmt_money2(p.estimate_total, state.current_currency)) : ''}${p.eligible ? '' : ' — ' + esc(p.reason)}
				</option>`).join(''));
			// Lalai = pakej LAYAK pertama (bukan option pertama — option
			// disabled tak boleh dipilih dan confirm akan gagal sisi server).
			const firstEligible = (d.packages || []).find((p) => p.eligible);
			if (firstEligible) {
				$sel.val(firstEligible.offer || firstEligible.package);
			}
			$sel.trigger('change');
		};

		const refresh = () =>
			api_edit('get_booking_reschedule_options', { booking }).then((payload) => {
				state = payload;
				if (!dlg) return;
				dlg.$body.html(render_body());
				if ((state.dates || []).length) {
					render_pkgs();
					dlg.$body.find('.mba-resched-datesel').on('change', render_pkgs);
					dlg.$body.find('.mba-resched-pkgsel').on('change', function () {
						const $opt = $(this).find('option:selected');
						const est = $opt.data('est');
						dlg.$body.find('.mba-resched-estimate')
							.text(est ? __('New total:') + ' ' + fmt_money2(est, state.current_currency) : '');
						update_btn();
					});
				}
			});

		const update_btn = () => {
			const reason = dlg.$body.find('.mba-editpax-reason-input').val().trim();
			const { tgd, pkg } = selected();
			dlg.$body.find('.mba-resched-confirm').prop('disabled', !(reason && tgd && pkg));
		};

		dlg = new frappe.ui.Dialog({
			title: __('Reschedule Booking'),
			size: 'large',
		});
		dlg.$body.html(render_body());
		refresh();
		dlg.show();
		dlg.$body.on('input', '.mba-editpax-reason-input', update_btn);

		dlg.$body.on('click', '.mba-resched-confirm', function () {
			const reason = dlg.$body.find('.mba-editpax-reason-input').val().trim();
			const { tgd, pkg } = selected();
			if (!reason || !tgd || !pkg) return;
			const $btn = $(this).prop('disabled', true);
			const $opt = dlg.$body.find('.mba-resched-pkgsel option:selected');
			api_edit('reschedule_booking', {
				booking,
				new_trip_group_date: tgd,
				new_package_offer: pkg,
				new_trip_package: $opt.data('pkg') || '',
				reason,
			}).then((r) => {
				frappe.show_alert({
					message: __('Rescheduled to {0}. New Sales Order {1} ({2}).',
						[frappe.datetime.str_to_user(r.departure_date), r.new_sales_order, fmt_money2(r.grand_total, r.currency)]),
					indicator: 'green',
				}, 7);
				dlg.hide();
				// Muat semula paparan L3 penuh
				// Muat semula page booking order penuh — tanpa bergantung pada
				// nama route (view boleh hidup dalam mana-mana direktori).
				reload_booking_view(booking);
			}).catch(() => {
				$btn.prop('disabled', false);
			});
		});
	}

	/* ---------- Fasa 1a: dialog Edit Pax (booking → SO propagation) ---------- */
	function open_edit_pax_dialog(booking) {
		let state = null;
		let dlg = null;

		const fmt_money = (v, cur) =>
			(cur || 'RM') + ' ' + flt(v).toFixed(2);

		const so_state_badge = (st) => {
			const map = {
				unpaid: ['gray', __('Unpaid')],
				partial: ['orange', __('Partially Paid')],
				paid_uninvoiced: ['green', __('Paid')],
				paid_invoiced: ['red', __('Paid + Invoiced')],
				missing: ['red', __('No Sales Order')],
			};
			const m = map[st] || ['gray', st];
			return badge(__(m[1]), m[0]);
		};

		const render_body = () => {
			const s = state;
			if (!s) return `<div class="text-muted">${__('Loading…')}</div>`;
			let html = '';
			// [Fasa 1d] Kes PENUH + BERINVOIS — laluan in-place disekat;
			// kabin tetap dipapar untuk laluan SO tambahan "Upgrade"
			// (create_cabin_upgrade_order) sahaja.
			const invoiced = s.so_state?.state === 'paid_invoiced';

			if ((s.blocked || []).length) {
				html += `<div class="mba-editpax-blocked">${
					s.blocked.map((b) => `<div>⚠ ${esc(__(b))}</div>`).join('')}</div>`;
			}

			// Medan sebab — WAJIB sebelum sebarang tindakan.
			html += `
				<div class="mba-editpax-reason">
					<label>${__('Reason for change')} <span class="text-danger">*</span></label>
					<input type="text" class="mba-editpax-reason-input form-control"
						placeholder="${esc(__('e.g. customer requested one fewer guest'))}" maxlength="500"/>
				</div>`;

			// Keadaan SO
			if (s.so_state && s.so_state.state !== 'missing') {
				html += `
					<div class="mba-editpax-sostate">
						<span>${esc(s.primary_so)}</span>
						${so_state_badge(s.so_state.state)}
						<span class="text-muted">${esc(__('Paid'))} ${esc(fmt_money(s.so_state.advance_paid, s.so_state.currency))}
							/ ${esc(fmt_money(s.so_state.grand_total, s.so_state.currency))}</span>
					</div>`;
			}

			// Kabin + pax semasa (buang) + tukar kategori (1b)
			if ((s.cabins || []).length) {
				html += `<div class="mba-editpax-section">${invoiced
					? __('Cabin Upgrade') + ` <span class="text-muted">(${esc(__('creates a supplementary Sales Order — the invoiced one is untouched'))})</span>`
					: __('Remove Guests')}</div>`;
				html += `<div class="mba-editpax-cabins">`;
				for (const c of s.cabins) {
					const catOpts = (c.category_options || []).filter((o) => o.eligible || o.reason);
					html += `
						<div class="mba-editpax-cabin">
							<div class="mba-editpax-cabin-h">
								${__('Cabin')} ${c.cabin_no} — ${esc(c.room_category)}
								${c.room_privacy ? `<span class="text-muted">(${esc(c.room_privacy)})</span>` : ''}
							</div>
							${invoiced ? '' : (c.pax || []).map((p) => `
								<div class="mba-editpax-row">
									<span>${esc(p.pax_type)} × ${p.count}</span>
									<span class="text-muted">${esc(fmt_money(p.unit_price, s.so_state?.currency))}</span>
									<button type="button" class="btn btn-xs btn-secondary mba-editpax-remove"
										data-cabin="${c.cabin_no}" data-pax="${esc(p.pax_type)}">
										${__('Remove 1')}</button>
								</div>`).join('')}
							${catOpts.length ? `
								<div class="mba-editpax-row mba-editpax-catrow">
									<span>${__('Room Category')}</span>
									<select class="form-control mba-editpax-catsel" data-cabin="${c.cabin_no}"
										style="max-width:170px;font-size:11px;padding:2px 6px;">
										${catOpts.map((o) => {
											// Kes berinvois: SO tambahan Upgrade hanya untuk
											// delta POSITIF — pengurangan harga kekal laluan
											// refund manual (keputusan produk Fasa 1).
											const blockedUp = invoiced && o.eligible && !(flt(o.delta) > 0);
											const disabled = !o.eligible || blockedUp;
											const why = !o.eligible ? o.reason
												: (blockedUp ? __('price reduction is not available on an invoiced booking') : '');
											return `
											<option value="${esc(o.category)}" ${disabled ? 'disabled' : ''}
												data-delta="${flt(o.delta || 0)}" data-total="${flt(o.new_total || 0)}"
												${disabled ? `title="${esc(why)}"` : ''}>
												${esc(o.category)}${!disabled && o.delta ? ' (' + (o.delta > 0 ? '+' : '') + esc(fmt_money(Math.abs(o.delta), s.so_state?.currency)) + ')' : ''}${disabled ? ' — ' + esc(why) : ''}
											</option>`;
										}).join('')}
									</select>
									<button type="button" class="btn btn-xs btn-secondary ${invoiced ? 'mba-editpax-upgrade' : 'mba-editpax-changecat'}"
										data-cabin="${c.cabin_no}">${invoiced ? __('Upgrade') : __('Change')}</button>
								</div>` : ''}
						</div>`;
				}
				html += `</div>`;
			}

			// Pilihan tambah (kabin shareable)
			const add = s.add_options;
			if (add && !add.unavailable && (add.cabins || []).length) {
				html += `<div class="mba-editpax-section">${__('Add Guest')} <span class="text-muted">(${esc(__('creates a new Sales Order'))})</span></div>`;
				html += `<div class="mba-editpax-cabins">`;
				for (const c of add.cabins) {
					html += `
						<div class="mba-editpax-cabin">
							<div class="mba-editpax-cabin-h">${__('Cabin')} ${c.cabin_no} — ${esc(c.room_category)}
								${c.eligible ? '' : `<span class="text-muted">(${esc(__('full'))})</span>`}</div>
							${(c.categories || []).map((k) => `
								<div class="mba-editpax-row">
									<span>${esc(k.label || k.key)}</span>
									<span class="text-muted">${esc(fmt_money(k.net_rate, add.currency))}</span>
									<button type="button" class="btn btn-xs btn-secondary mba-editpax-add"
										data-cabin="${c.cabin_no}" data-cat="${esc(k.key)}"
										${(k.disabled || !c.eligible) ? 'disabled title="' + esc(k.disabled_reason || __('Not available')) + '"' : ''}>
										${__('Add')}</button>
								</div>`).join('')}
						</div>`;
				}
				html += `</div>`;
			}

			return html;
		};

		const refresh = () =>
			api_edit('get_booking_edit_state', { booking }).then((payload) => {
				state = payload;
				if (dlg) dlg.$body.html(render_body());
			});

		dlg = new frappe.ui.Dialog({
			title: __('Edit Pax') + ' — ' + (state?.booking_number || booking),
			size: 'large',
		});
		dlg.$body.html(render_body());
		refresh();
		dlg.show();

		// Reason wajib — butang tindakan aktif hanya bila diisi.
		dlg.$body.on('input', '.mba-editpax-reason-input', function () {
			const ok = !!$(this).val().trim();
			dlg.$body.find('.mba-editpax-remove, .mba-editpax-add').prop('disabled', !ok);
		});
		// Keadaan awal: butang tidak aktif sehingga sebab diisi.
		dlg.$body.find('.mba-editpax-remove, .mba-editpax-add, .mba-editpax-changecat, .mba-editpax-upgrade').prop('disabled', true);

		// [Fasa 1d] Kes PENUH + BERINVOIS — upgrade melalui SO tambahan
		// "Upgrade" (delta); SO utama berinvois kekal sepenuhnya.
		dlg.$body.on('click', '.mba-editpax-upgrade', function () {
			const reason = dlg.$body.find('.mba-editpax-reason-input').val().trim();
			if (!reason) return;
			const $btn = $(this).prop('disabled', true);
			const $row = $btn.closest('.mba-editpax-catrow');
			const $sel = $row.find('.mba-editpax-catsel');
			const newCat = $sel.val();
			if (!newCat) return;
			api_edit('create_cabin_upgrade_order', {
				booking,
				cabin_no: $btn.data('cabin'),
				new_category: newCat,
				reason,
			}).then((r) => {
				frappe.show_alert({
					message: __('Upgraded to {0}. Upgrade Sales Order {1} created ({2}); collect via Payment Link.',
						[r.new_category, r.upgrade_sales_order, fmt_money(r.delta, r.currency)]),
					indicator: 'green',
				}, 8);
				refresh();
			}).catch(() => {
				$btn.prop('disabled', false);
				refresh();
			});
		});

		dlg.$body.on('click', '.mba-editpax-changecat', function () {
			const reason = dlg.$body.find('.mba-editpax-reason-input').val().trim();
			if (!reason) return;
			const $btn = $(this).prop('disabled', true);
			const $row = $btn.closest('.mba-editpax-catrow');
			const $sel = $row.find('.mba-editpax-catsel');
			const newCat = $sel.val();
			if (!newCat) return;
			api_edit('change_booking_cabin_category', {
				booking,
				cabin_no: $btn.data('cabin'),
				new_category: newCat,
				reason,
			}).then((r) => {
				frappe.show_alert({
					message: __('Category changed to {0}. New total: {1}.', [r.new_category, fmt_money(r.grand_total, r.currency)]),
					indicator: 'green',
				}, 6);
				refresh();
			}).catch(() => {
				$btn.prop('disabled', false);
				refresh();
			});
		});

		dlg.$body.on('click', '.mba-editpax-remove', function () {
			const reason = dlg.$body.find('.mba-editpax-reason-input').val().trim();
			if (!reason) return;
			const $btn = $(this).prop('disabled', true);
			api_edit('remove_booking_pax', {
				booking,
				cabin_no: $btn.data('cabin'),
				pax_type: $btn.data('pax'),
				qty: 1,
				reason,
			}).then((r) => {
				const credit = r && r.credit_balance > 0
					? __(' Credit balance: {0}.', [fmt_money(r.credit_balance, r.currency)])
					: '';
				frappe.show_alert({
					message: __('Removed. New total: {0}.{1}', [fmt_money(r.grand_total, r.currency), credit]),
					indicator: 'green',
				}, 6);
				refresh();
			}).catch(() => {
				$btn.prop('disabled', false);
				refresh();
			});
		});

		dlg.$body.on('click', '.mba-editpax-add', function () {
			const reason = dlg.$body.find('.mba-editpax-reason-input').val().trim();
			if (!reason) return;
			const $btn = $(this).prop('disabled', true);
			api_edit('add_booking_pax', {
				booking,
				cabin_no: $btn.data('cabin'),
				category: $btn.data('cat'),
				reason,
			}).then((r) => {
				frappe.show_alert({
					message: __('Added. Sales Order {0} created ({1}).',
						[r.sales_order, fmt_money(r.grand_total, r.currency)]),
					indicator: 'green',
				}, 6);
				refresh();
			}).catch(() => {
				$btn.prop('disabled', false);
				refresh();
			});
		});
	}

	/* ---------- Fasa 1e: dialog Roommate Match (solo "Open Sharing" → twin share) ---------- */
	function open_roommate_match_dialog(booking) {
		let state = null;
		let dlg = null;

		const fmt_money = (v, cur) =>
			(cur || 'RM') + ' ' + flt(v).toFixed(2);

		const selected_partner = () =>
			dlg.$body.find('input[name="mba-match-cand"]:checked').val() || '';

		const render_body = () => {
			const s = state;
			if (!s) return `<div class="text-muted">${__('Loading…')}</div>`;
			let html = '';

			if (!s.eligible) {
				html += `<div class="mba-editpax-blocked"><div>⚠ ${esc(__(s.reason || __('Not eligible.')))}</div></div>`;
				return html;
			}

			// Ringkasan sisi booking ini — kadar single (snapshot SO) →
			// kadar twin semasa + lebihan single-supplement.
			const solo = s.solo || {};
			html += `
				<div class="mba-editpax-sostate">
					<span>${esc(__('Cabin'))} ${solo.cabin_no} — ${esc(solo.room_category)}
						<span class="text-muted">(${esc(solo.gender || __('no declared gender'))})</span></span>
					<span class="text-muted">${esc(__('Single'))} ${esc(fmt_money(solo.single_rate, solo.currency))}
						→ ${esc(__('twin'))} ${esc(fmt_money(solo.twin_rate, solo.currency))}</span>
				</div>
				<div class="mba-editpax-row">
					<span class="text-muted">${esc(__('Single-occupancy difference (refund preview):'))}
						<strong>${esc(fmt_money(solo.excess, solo.currency))}</strong></span>
				</div>
				<div class="mba-editpax-reason">
					<label>${__('Reason for match')} <span class="text-danger">*</span></label>
					<input type="text" class="mba-editpax-reason-input form-control"
						placeholder="${esc(__('e.g. matched with another solo traveller of the same gender'))}" maxlength="500"/>
				</div>
				<div class="mba-editpax-section">${__('Match With')}</div>
				<div class="mba-editpax-cabins mba-match-list">`;

			if (!(s.candidates || []).length) {
				html += `<div class="text-muted">${__(
					'No eligible solo "Open Sharing" travellers on this sailing yet — same room category and declared gender required.')}</div>`;
			}
			for (const c of (s.candidates || [])) {
				html += `
					<label class="mba-match-cand">
						<input type="radio" name="mba-match-cand" value="${esc(c.booking)}"/>
						<span class="mba-match-cand-name">${esc(c.traveller_name || c.booking_number)}</span>
						<span class="text-muted">${esc(c.booking_number)} · ${esc(c.gender)} ·
							${esc(fmt_money(c.single_rate, c.currency))} → ${esc(fmt_money(c.twin_rate, c.currency))}</span>
					</label>`;
			}
			html += `</div>
				<div class="mba-editpax-row mba-editpax-catrow">
					<button type="button" class="btn btn-sm btn-secondary mba-match-confirm" disabled>
						${__('Match & Apply Twin Share')}</button>
					<span class="text-muted" style="font-size:11px;">${esc(__('fares switch to the twin-share rate where it is lower; any overpayment is flagged for manual refund'))}</span>
				</div>`;
			return html;
		};

		const update_btn = () => {
			const reason = dlg.$body.find('.mba-editpax-reason-input').val().trim();
			dlg.$body.find('.mba-match-confirm')
				.prop('disabled', !(reason && selected_partner()));
		};

		const refresh = () =>
			api_edit('get_roommate_match_state', { booking }).then((payload) => {
				state = payload;
				if (dlg) dlg.$body.html(render_body());
			});

		dlg = new frappe.ui.Dialog({
			title: __('Roommate Matched — Twin Share'),
			size: 'large',
		});
		dlg.$body.html(render_body());
		refresh();
		dlg.show();
		dlg.$body.on('input', '.mba-editpax-reason-input', update_btn);
		dlg.$body.on('change', 'input[name="mba-match-cand"]', update_btn);

		dlg.$body.on('click', '.mba-match-confirm', function () {
			const reason = dlg.$body.find('.mba-editpax-reason-input').val().trim();
			const partner = selected_partner();
			if (!reason || !partner) return;
			const $btn = $(this).prop('disabled', true);
			api_edit('apply_roommate_match', {
				booking,
				partner_booking: partner,
				reason,
			}).then((r) => {
				const lines = [r.owner, r.joiner].map((x) =>
					__('{0}: new total {1}{2}.', [
						x.booking_number,
						fmt_money(x.grand_total, x.currency),
						x.credit_balance > 0
							? ' ' + __('credit {0} — flagged for refund', [fmt_money(x.credit_balance, x.currency)])
							: '',
					])).join(' ');
				frappe.show_alert({
					message: __('Roommates matched. {0}', [lines]),
					indicator: 'green',
				}, 8);
				dlg.hide();
				// Muat semula paparan L3 penuh (tab Rooms/Travellers/Documents
				// — kadar + penempatan bilik berubah).
				// Muat semula page booking order penuh — tanpa bergantung pada
				// nama route (view boleh hidup dalam mana-mana direktori).
				reload_booking_view(booking);
			}).catch(() => {
				$btn.prop('disabled', false);
			});
		});
	}

	function open_payment_link_dialog(booking) {
		api('get_booking_payment_links', { booking }).then((payload) => {
			if (!payload) return;
			let data = payload;   // diganti semula selepas generate (re-fetch)

			const dlg = new frappe.ui.Dialog({
				title: __('Payment Link') + ' — ' + (payload.booking_number || booking),
				size: 'large',
			});
			const sel = new Set((payload.sos || []).map((s) => s.name));
			// Baris dokumen — pilihan (label boleh klik) + input JUMLAH
			// ALOKASI boleh sunting (lalai = baki penuh; 0 < jumlah ≤ baki
			// SO itu — validasi ERPNext Payment Request).
			const soRows = (payload.sos || []).map((so) => `
				<div class="mba-paylink-so">
					<label class="mba-paylink-sel">
						<input type="checkbox" class="mba-paylink-check" data-so="${esc(so.name)}"
							${sel.has(so.name) ? 'checked' : ''}/>
						<span class="mba-paylink-soname">${esc(so.name)}
							${so.is_addon ? badge(__('Addon Order'), 'gray') : badge(__('Sales Order'), 'blue')}</span>
					</label>
					<span class="mba-paylink-amtwrap"
						title="${esc(__('Amount to charge for this order — edit for a partial payment'))}">
						<input type="number" class="mba-paylink-amt" inputmode="decimal"
							min="0.01" max="${so.balance}" step="0.01" value="${so.balance}"
							${sel.has(so.name) ? '' : 'disabled'}/>
						<span class="mba-paylink-cur">${esc(so.currency)}</span>
					</span>
				</div>`).join('');

			dlg.$body.html(`
				<div class="mba-paylink">
					<div class="mba-paylink-sec">
						<div class="mba-paylink-head">${__('Outstanding Orders')}</div>
						${soRows || `<div class="mba-paylink-empty">${__('No outstanding balance on this booking.')}</div>`}
						<div class="mba-paylink-total">
							<span>${__('Selected Total')}</span>
							<b data-pl-total>—</b>
							<span class="mba-mitem-s" data-pl-count></span>
						</div>
						<div class="mba-paylink-warn" data-pl-warn style="display:none">
							${__('Mixed currencies cannot share one payment — generate a separate link per currency.')}
						</div>
						<div class="mba-paylink-genrow">
							<button type="button" class="btn btn-primary btn-sm mba-paylink-gen">${__('Generate Payment Link')}</button>
							<span class="mba-mitem-s">${__('Amounts are editable for partial payment. Generating a new link cancels previous unpaid links for the same orders.')}</span>
						</div>
					</div>
					<div class="mba-paylink-sec" data-pl-result>
						${paylink_result_html(data)}
					</div>
				</div>`);

			const $body = dlg.$body;
			const $gen = $body.find('.mba-paylink-gen');

			// Jumlah ikut pilihan + nilai input alokasi semasa (bukan baki
			// penuh). Input tak sah (kosong / ≤0 / melebihi baki SO) → baris
			// ditanda merah & butang jana dikunci. Currency bercampur turut
			// dikunci — satu pembayaran gabungan wajib satu currency.
			const recompute = () => {
				const chosen = [];
				let invalid = false;
				$body.find('.mba-paylink-so').each(function () {
					const $row = $(this);
					const $chk = $row.find('.mba-paylink-check');
					const so = (data.sos || []).find((x) => x.name === $chk.data('so'));
					const $amt = $row.find('.mba-paylink-amt');
					const on = $chk.prop('checked');
					$amt.prop('disabled', !on);
					if (!so || !on) { $row.removeClass('is-invalid'); return; }
					const v = parseFloat($amt.val());
					const bad = !(v > 0) || v > so.balance + 0.009;
					$row.toggleClass('is-invalid', bad);
					if (bad) { invalid = true; return; }
					chosen.push({ amount: round2(v), currency: so.currency });
				});
				const totals = paylink_totals(chosen, 'amount', 'currency');
				$body.find('[data-pl-total]').text(
					Object.keys(totals).map((c) => fmtMoney(totals[c], c)).join(' + ') || '—');
				$body.find('[data-pl-count]').text(
					chosen.length ? chosen.length + ' ' + __('selected') : '');
				const mixed = Object.keys(totals).length > 1;
				$body.find('[data-pl-warn]').toggle(mixed);
				$gen.prop('disabled', !chosen.length || mixed || invalid);
			};

			const refresh_result = () => $body.find('[data-pl-result]').html(paylink_result_html(data));

			const do_generate = () => {
				const sales_orders = [];
				const amounts = {};
				let valid = true;
				$body.find('.mba-paylink-so').each(function () {
					const $row = $(this);
					const $chk = $row.find('.mba-paylink-check');
					if (!$chk.prop('checked')) return;
					const so = (data.sos || []).find((x) => x.name === $chk.data('so'));
					const name = String($chk.data('so'));
					const v = parseFloat($row.find('.mba-paylink-amt').val());
					if (!so || !(v > 0) || v > so.balance + 0.009) { valid = false; return; }
					sales_orders.push(name);
					amounts[name] = round2(v);
				});
				if (!valid || !sales_orders.length) return;
				$gen.prop('disabled', true).text(__('Generating…'));
				api('create_booking_payment_link', { booking, sales_orders, amounts })
					.then(() => api('get_booking_payment_links', { booking }))
					.then((fresh) => {
						if (fresh) data = fresh;
						refresh_result();
						frappe.show_alert({ message: __('Payment link generated'), indicator: 'green' }, 5);
					})
					.finally(() => {
						$gen.prop('disabled', false).text(__('Generate Payment Link'));
						recompute();
					});
			};

			const do_copy = () => {
				const url = ((data.links || [])[0] || {}).checkout_url || '';
				if (url) frappe.utils.copy_to_clipboard(url);
			};

			const do_email = () => {
				const prs = (data.links || []).map((l) => l.payment_request);
				if (!prs.length) return;
				const $btn = $body.find('.mba-paylink-email').prop('disabled', true);
				api('send_booking_payment_email', { booking, payment_requests: prs })
					.then((r) => {
						frappe.show_alert({
							message: __('Email sent to {0}', [r?.sent_to || 'customer']),
							indicator: 'green',
						}, 5);
					})
					.finally(() => $btn.prop('disabled', false));
			};

			$body
				.on('change', '.mba-paylink-check', recompute)
				.on('input change', '.mba-paylink-amt', recompute)
				.on('focus', '.mba-paylink-urlrow input', function () { this.select(); })
				.on('click', '.mba-paylink-gen', do_generate)
				.on('click', '.mba-paylink-copy', do_copy)
				.on('click', '.mba-paylink-email', do_email);

			recompute();
			dlg.show();
		});
	}

	const bkg_section = (title, count, inner) => `
		<div class="mba-section-title">${title}
			${count !== '' && count != null ? `<span class="mba-count-pill">${count}</span>` : ''}
		</div>${inner}`;

	// Kiraan operasi + chips (Discount / Travellers / Rooms / Pending Docs)
	const bkg_ops_counts = (d) => {
		const res = d.reservations || [];
		const active = res.filter((t) => t.reservation_status !== 'Cancelled');
		const pendingDocs = res.filter((t) => !DOC_STATUS_OK.includes(t.document_status)).length;
		return { total: res.length, active: active.length, cancelled: res.length - active.length, pendingDocs };
	};

	function bkg_ops_chips(d) {
		const o = bkg_ops_counts(d);
		const dsc = bkg_discount(d.profile || {});
		const chips = [
			dsc.total > 0 ? `<span class="mba-bkg-chip">${__('Discount')} <b>${fmtMoney(dsc.total, dsc.cur)}</b></span>` : '',
			`<span class="mba-bkg-chip">${__('Travellers')} <b>${o.active}</b></span>`,
			`<span class="mba-bkg-chip">${__('Rooms')} <b>${d.rooming_count ?? 0}</b></span>`,
			o.pendingDocs ? `<span class="mba-bkg-chip mba-bkg-chip--danger">${__('Pending Docs')} <b>${o.pendingDocs}</b></span>` : '',
		].filter(Boolean).join('');
		return chips ? `<div class="mba-bkg-mchips">${chips}</div>` : '';
	}

	// ── Order Summary — parse field virtual Booking 'order_summary' (server
	// kira live daripada SO utama; pecahan ikut kabin + baris diskaun). ──
	function mba_parse_order_summary(txt) {
		const splitMoney = (t) => {
			const m = t.match(/^(.*?)\s*([^\s\d.,]+)\s*(-?[\d,]+\.\d{2})$/);
			if (!m) return null;
			return {
				label: m[1].replace(/[—–-]\s*$/, '').replace(/:\s*$/, '').trim(),
				cur: m[2], amt: m[3],
			};
		};
		const cabins = [], dscs = [];
		let cur = null;
		(txt || '').split('\n').forEach((raw) => {
			const t = raw.trim();
			if (!t) return;
			if (/^[ \t]/.test(raw)) {
				if (!cur) return;
				const mm = splitMoney(t);
				if (!mm) return;
				if (/^cabin fare/i.test(t)) { cur.fare = mm; return; }
				const g = mm.label.match(/^(Guest\s*\d+)\s*:?\s*(.*)$/i);
				cur.guests.push({
					who: g ? [g[1], g[2]].filter(Boolean).join(' · ') : mm.label,
					cur: mm.cur, amt: mm.amt,
				});
				return;
			}
			const mm = splitMoney(t);
			if (mm) { dscs.push(mm); return; }
			cur = { name: t, fare: null, guests: [] };
			cabins.push(cur);
		});
		return { cabins, dscs };
	}

	function bkg_order_summary(d) {
		const os = mba_parse_order_summary((d.profile || {}).order_summary);
		if (!os.cabins.length) return '';
		const amt = (x) => (x.amt.startsWith('-')
			? `− ${esc(x.cur)} ${esc(x.amt.slice(1))}`
			: `${esc(x.cur)} ${esc(x.amt)}`);
		const cards = os.cabins.map((c) => `
			<div class="mba-bkg-osum-cabin">
				<div class="mba-bkg-osum-name">${esc(c.name)}</div>
				${c.fare ? `<div class="mba-bkg-osum-row is-fare"><span>${__('Cabin Fare')}</span><b>${amt(c.fare)}</b></div>` : ''}
				${c.guests.map((g) => `
				<div class="mba-bkg-osum-row"><span>${esc(g.who)}</span><span>${amt(g)}</span></div>`).join('')}
			</div>`).join('');
		const dscs = os.dscs.map((x) => `
			<div class="mba-bkg-osum-row is-dsc"><span>${esc(x.label)}</span><span>${amt(x)}</span></div>`).join('');
		return bkg_section(__('Order Summary'), os.cabins.length,
			`${bkg_ops_chips(d)}<div class="mba-bkg-osum">${cards}${dscs}</div>`);
	}

	// ── Timeline booking — created → PI/SO → payments → T&C, disusun ikut
	// tarikh + item semasa/hadapan. Default: 5 peristiwa terkini sahaja
	// (butang "Show earlier"); S.tlAll memaparkan penuh. ────────────────
	function bkg_timeline(d) {
		const p = d.profile || {};
		const ev = [];
		if (p.creation) ev.push({
			date: p.creation.slice(0, 10), cls: '',
			html: __('Booking created')
				+ (p.booking_channel ? ' — ' + esc(p.booking_channel) : '')
				+ (p.checkout_method ? ' · ' + esc(p.checkout_method) : ''),
		});
		(d.documents?.proforma_invoices || []).filter((x) => x.docstatus !== 2).forEach((pf) => ev.push({
			date: pf.proforma_date, cls: 'doc',
			html: `${badge(__('Proforma'), 'violet')} <a href="/app/proforma-invoice/${esc(pf.name)}">${esc(pf.name)}</a> · ${fmtMoney(pf.grand_total, pf.currency)}`,
		}));
		(d.documents?.sales_orders || []).filter((x) => x.docstatus === 1).forEach((so) => ev.push({
			date: so.transaction_date || (so.creation || '').slice(0, 10), cls: 'doc',
			html: `${badge(so.is_addon ? __('Addon Order') : __('Sales Order'), 'blue')} <a href="/app/sales-order/${esc(so.name)}">${esc(so.name)}</a> · ${fmtMoney(so.grand_total, so.currency)}`,
		}));
		(d.reservations || []).forEach((t) => {
			if (t.reservation_status === 'Cancelled') return;
			const reg = (t.traveller_created || '').slice(0, 10);
			if (reg) ev.push({
				date: reg, cls: '',
				html: `${badge(__('Traveller'), 'cyan')} ${__('Registered')} — <b>${esc(t.traveller_name)}</b>`,
			});
			const upd = {};
			(t.traveller_versions || []).forEach((v) => {
				const d0 = String(v).slice(0, 10);
				if (d0 && d0 !== reg) upd[d0] = (upd[d0] || 0) + 1;
			});
			if (!Object.keys(upd).length) {
				const mod = (t.traveller_modified || '').slice(0, 10);
				if (mod && mod !== reg) upd[mod] = 1;
			}
			Object.keys(upd).sort().forEach((d0) => ev.push({
				date: d0, cls: '',
				html: `${__('Traveller updated')} — <b>${esc(t.traveller_name)}</b>`
					+ (upd[d0] > 1 ? ` ×${upd[d0]}` : ''),
			}));
		});
		bkg_pe_rows(d).filter((pe) => pe.docstatus !== 2).forEach((pe) => {
			const amt = Object.entries(pe.amounts).map(([cur, v]) => fmtMoney(v, cur)).join(' · ');
			ev.push({
				date: pe.date, cls: 'pay',
				html: `${__('Payment')} <a href="/app/payment-entry/${esc(pe.name)}">${esc(pe.name)}</a> · ${amt}`,
			});
		});
		if (p.terms_accepted && p.terms_accepted_at) ev.push({
			date: p.terms_accepted_at.slice(0, 10), cls: 'ok',
			html: __('T&C accepted by customer'),
		});
		if (!ev.length) return '';
		ev.sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')));

		// Item semasa / hadapan.
		const tail = [];
		const money = p.money_by_currency || [];
		if (hasBalance(money)) tail.push(`
			<div class="mba-bkg-tli mba-bkg-tli--future">
				<div class="mba-bkg-tld">${__('Now')}</div>
				<div>${__('Outstanding balance')} <b>${fmtCurRows(money, 'balance')}</b></div>
			</div>`);
		const sail = p.is_a_cruise_trip ? (p.cruise_start || p.departure_date) : p.departure_date;
		if (sail) tail.push(`
			<div class="mba-bkg-tli mba-bkg-tli--future">
				<div class="mba-bkg-tld">${fmtDate(sail)}</div>
				<div>${__('Sail')} — ${esc(p.ship_name || p.trip_title || '')}</div>
			</div>`);

		// Ringkaskan — 5 peristiwa terkini sahaja secara default.
		let visible = ev;
		let moreBtn = '';
		if (!S.tlAll && ev.length > 5) {
			visible = ev.slice(-5);
			moreBtn = `<button type="button" class="btn btn-default btn-xs mba-tl-toggle">${__('Show earlier events')} (${ev.length - 5})</button>`;
		}

		const items = visible.map((e) => `
			<div class="mba-bkg-tli ${e.cls ? 'mba-bkg-tli--' + e.cls : ''}">
				<div class="mba-bkg-tld">${e.date ? fmtDate(e.date) : ''}</div>
				<div>${e.html}</div>
			</div>`).join('');
		// Wrapper .mba-bkg-tlwrap — skop gaya "sangat kecil & muted" pada
		// seksyen timeline sahaja (tajuk + kandungan), tanpa sentuh gaya
		// section lain (Order Summary dsb.).
		return `<div class="mba-bkg-tlwrap">${bkg_section(__('Booking Timeline'), ev.length + tail.length,
			`${moreBtn}<div class="mba-bkg-tl">${items}${tail.join('')}</div>`)}</div>`;
	}

	function render_bkg_overview(key) {
		const d = S.cache[key]?.profile;
		if (!d) return;
		// Strip wang (Order → Paid → Balance + Payment Status) berada dalam
		// kandungan tab Overview — bahagian atas, sebelum Order Summary.
		$('#mba-detail').find(`.mba-group[data-item="${key}"] .mba-tab-pane[data-pane="ov"]`)
			.html(`${bkg_money_strip(d.profile)}${bkg_schedule_strip(d)}${bkg_order_summary(d)}${bkg_timeline(d)}`);
	}

	// ── Tab Rooms L3 — PAKEJ ROOMING LIST (rooms_list.js) diguna semula
	// untuk skop SATU booking: get_group_rooming(booking=<name>) memulangkan
	// bilik yang mengandungi reservation booking ini, LENGKAP dengan
	// penghuni kongsi merentas booking (highlight 'is-cross' oleh pakej).
	// Klik tetamu → modal maklumat traveller penuh (lalai pakej); pintasan
	// Rooming Board menuju route group/batch booking ini. ──
	async function load_bkg_rooms(key, force = false) {
		if (!key || !key.startsWith('bkg:')) return;
		if (!force && S.cache[key]?.bkgrooms) {
			render_bkg_rooms(key);
			return;
		}
		const $pane = $('#mba-detail').find(`.mba-group[data-item="${key}"] .mba-tab-pane[data-pane="rm"]`);
		if ($pane.length) $pane.html(`<div class="mba-loading">${__('Loading rooms...')}</div>`);
		try {
			// Skop satu booking — biliknya sedikit; muat semua (limit 0).
			const rm = await api('get_group_rooming', { booking: key.slice(4), limit: 0 });
			S.cache[key] = { ...(S.cache[key] || {}), bkgrooms: rm };
		} catch (e) {
			return; // api() sudah papar alert ralat
		}
		// Pill kiraan bilik pada tab.
		const n = S.cache[key]?.bkgrooms?.count || 0;
		const $pill = $('#mba-detail').find(`.mba-group[data-item="${key}"] .mba-tab[data-tab="rm"] [data-rm-pill]`);
		if ($pill.length) $pill.text(n).toggle(n > 0);
		// Render hanya bila tab masih dibuka pada item yang sama.
		const $tab = $('#mba-detail').find(`.mba-group[data-item="${key}"] .mba-tab[data-tab="rm"]`);
		if ($tab.hasClass('active')) render_bkg_rooms(key);
	}

	function render_bkg_rooms(key) {
		const rm = S.cache[key]?.bkgrooms;
		if (!rm) return;
		const pane = $('#mba-detail').find(`.mba-group[data-item="${key}"] .mba-tab-pane[data-pane="rm"]`);
		if (!pane.length) return;

		const rooms = rm.rooms || [];
		const pax = rooms.reduce((n, r) => n + (r.guests || []).length, 0);

		// Pintasan Rooming Board — route penuh group/batch booking ini
		// (susun atur bilik diurus di papan, bukan di sini).
		const p = S.cache[key]?.profile?.profile || {};
		const boardBtn = p.trip_date
			? `<button type="button" class="btn btn-secondary btn-sm mba-rb-open-bkg mba-toolbar-push"
					data-group="${esc(p.group_batch ? p.group_batch : p.trip_date)}"
					data-kind="${p.group_batch ? 'batch' : 'group'}">
					${__('Rooming Board')}</button>` : '';

		pane.html(bkg_section(__('Rooms'), rm.count ?? 0, `
			<div class="mba-tab-toolbar">
				<span class="mba-muted">${rooms.length} ${__('rooms')} · ${pax} ${__('guests')}</span>
				${boardBtn}
			</div>
			<div class="mba-rooms-slot"></div>`));

		// Grid kad bilik — pakej rooms_list.js (klik tetamu → modal
		// maklumat traveller, lalai pakej).
		mount_rooms_list(pane.find('.mba-rooms-slot'), rm, {
			empty_message: __('No rooms arranged for this booking yet.'),
		});
	}

	// ── Tab Add-ons & Flights L3 — dimuatkan lazily daripada
	// get_booking_addons_flights (addon order booking ni + Flight yang
	// dirujuk Booking.flight). Selari bentuk row L2 supaya kad/jadual
	// konsisten; klik kad/baris → form dokumen (handler .mba-bkcard). ──
	async function load_bkg_af(key, force = false) {
		if (!key || !key.startsWith('bkg:')) return;
		if (!force && S.cache[key]?.afdata) {
			render_bkg_af(key);
			return;
		}
		const $pane = $('#mba-detail').find(`.mba-group[data-item="${key}"] .mba-tab-pane[data-pane="af"]`);
		if ($pane.length) $pane.html(`<div class="mba-loading">${__('Loading add-ons & flights...')}</div>`);
		try {
			const d = await api('get_booking_addons_flights', { booking: key.slice(4) });
			S.cache[key] = { ...(S.cache[key] || {}), afdata: d };
		} catch (e) {
			return; // api() sudah papar alert ralat
		}
		// Pill kiraan pada tab — add-on + flight booking ni.
		const n = (S.cache[key]?.afdata?.addons?.length || 0)
			+ (S.cache[key]?.afdata?.flights?.length || 0);
		const $pill = $('#mba-detail').find(`.mba-group[data-item="${key}"] .mba-tab[data-tab="af"] [data-af-pill]`);
		if ($pill.length) $pill.text(n).toggle(n > 0);
		// Render hanya bila tab masih dibuka pada item yang sama.
		const $tab = $('#mba-detail').find(`.mba-group[data-item="${key}"] .mba-tab[data-tab="af"]`);
		if ($tab.hasClass('active')) render_bkg_af(key);
	}

	function render_bkg_af(key) {
		const d = S.cache[key]?.afdata;
		if (!d) return;
		const pane = $('#mba-detail').find(`.mba-group[data-item="${key}"] .mba-tab-pane[data-pane="af"]`);
		if (!pane.length) return;

		// ── Add-on order booking ni (tiada kolum Booking — semua milik
		// booking ini). ──
		const adRows = d.addons || [];
		const adTot = d.totals || {};
		const adDt = adTot.default_totals || { currency: S.currency, amount: 0, rates_complete: true };
		const adIncomplete = adDt.rates_complete === false ? '+' : '';

		const adCards = adRows.map((a) => `
			<div class="mba-bkcard" data-route="Booking Addon/${esc(a.name)}">
				<div class="mba-bkcard-top">
					<span class="mba-bkcard-no">${esc(a.name)}</span>
					${badge(a.status, ADDON_STATUS_COLORS[a.status])}
				</div>
				<div class="mba-bkcard-cust">${esc(a.package_offer || a.booking_number || '—')}</div>
				<div class="mba-bkcard-foot">
					${badge(a.payment_status, PAYMENT_STATUS_COLORS[a.payment_status])}
					<span><b>${fmtMoney(a.total_amount, a.currency || S.currency)}</b> · ${a.item_count} ${__('items')}</span>
				</div>
			</div>`).join('');

		const adTable = `
			<div class="mba-table-wrap">
				<table class="mba-table">
					<thead><tr>
						<th>${__('Addon No')}</th>
						<th>${__('Package')}</th>
						<th>${__('Status')}</th>
						<th>${__('Payment')}</th>
						<th class="num">${__('Items')}</th>
						<th class="num">${__('Amount')}</th>
						<th class="num">${__('Order Date')}</th>
					</tr></thead>
					<tbody>${adRows.map((a) => `
						<tr data-route="Booking Addon/${esc(a.name)}">
							<td><div class="mba-cell-main">${esc(a.name)}</div></td>
							<td>${esc(a.trip_package || '—')}</td>
							<td>${badge(a.status, ADDON_STATUS_COLORS[a.status])}</td>
							<td>${badge(a.payment_status, PAYMENT_STATUS_COLORS[a.payment_status])}</td>
							<td class="num">${a.item_count}</td>
							<td class="num">${fmtMoney(a.total_amount, a.currency || S.currency)}</td>
							<td class="num mba-muted">${fmtDateTime(a.order_date)}</td>
						</tr>`).join('')}
					</tbody>
					${adRows.length ? `<tfoot><tr>
						<td colspan="5">${__('Total')} (${adRows.length} ${__('addon orders')})
							<span class="mba-muted">· ${esc(adDt.currency || S.currency)}${adIncomplete}</span></td>
						<td class="num" title="${(adTot.by_currency || []).length ? esc(__('Per currency') + ': ' + adTot.by_currency.map((r) => fmtMoney(r.amount, r.currency)).join(' · ')) : ''}">${fmtMoney(adDt.amount, adDt.currency)}</td>
						<td></td>
					</tr></tfoot>` : ''}
				</table>
			</div>`;

		const addonsSec = bkg_section(__('Booking Addons'), adRows.length,
			adRows.length
				? `<div class="mba-cards">${adCards}</div>${adTable}`
				: `<div class="mba-empty">${__('No addon orders for this booking.')}</div>`);

		// ── Flight booking ni (Booking.flight) — statistik flight-wide
		// (bookings/pax) + pax booking ini sendiri. ──
		const flRows = d.flights || [];
		const route = (f) => [f.home_airport, f.destination_airport].filter(Boolean).join(' → ');

		const flCards = flRows.map((f) => `
			<div class="mba-bkcard" data-route="Flight/${esc(f.name)}">
				<div class="mba-bkcard-top">
					<span class="mba-bkcard-no">${esc(f.pnr)}</span>
					${badge(f.status, FLIGHT_STATUS_COLORS[f.status])}
				</div>
				<div class="mba-bkcard-cust">${f.airline ? esc(f.airline_name || f.airline) : '—'}</div>
				<div class="mba-bkcard-meta">${route(f) ? esc(route(f)) : ''}${f.departure_date ? ' · ' + fmtDate(f.departure_date) : ''}</div>
				<div class="mba-bkcard-foot">
					<span>${f.seats_occupied}/${f.max_seat || '—'} ${__('seats')} · ${f.booking_count} ${__('bookings')} · ${f.pax} ${__('pax')}</span>
					<span>${f.pax_booking} ${__('pax')} — ${__('this booking')}</span>
				</div>
			</div>`).join('');

		const flTable = `
			<div class="mba-table-wrap">
				<table class="mba-table">
					<thead><tr>
						<th>${__('PNR')}</th>
						<th>${__('Airline')}</th>
						<th>${__('Route')}</th>
						<th class="num">${__('Departure')}</th>
						<th class="num">${__('Arrival')}</th>
						<th class="num" title="${__('Seats occupied / max seats')}">${__('Seats')}</th>
						<th class="num">${__('Bookings')}</th>
						<th class="num">${__('Pax')}</th>
						<th class="num" title="${__('Pax from this booking on this flight')}">${__('Booking Pax')}</th>
						<th>${__('Status')}</th>
					</tr></thead>
					<tbody>${flRows.map((f) => `
						<tr data-route="Flight/${esc(f.name)}">
							<td><div class="mba-cell-main">${esc(f.pnr)}</div></td>
							<td>${f.airline ? esc(f.airline_name || f.airline) : '—'}</td>
							<td>${route(f) ? esc(route(f)) : '—'}</td>
							<td class="num">${f.departure_date ? fmtDate(f.departure_date) : '—'}</td>
							<td class="num">${f.arrival_date ? fmtDate(f.arrival_date) : '—'}</td>
							<td class="num">${f.seats_occupied}/${f.max_seat || '—'}</td>
							<td class="num">${f.booking_count}</td>
							<td class="num">${f.pax}</td>
							<td class="num">${f.pax_booking}</td>
							<td>${badge(f.status, FLIGHT_STATUS_COLORS[f.status])}</td>
						</tr>`).join('')}
					</tbody>
				</table>
			</div>`;

		const flightsSec = bkg_section(__('Flights'), flRows.length,
			flRows.length
				? `<div class="mba-cards">${flCards}</div>${flTable}`
				: `<div class="mba-empty">${__('No flight linked to this booking.')}</div>`);

		pane.html(addonsSec + flightsSec);
	}

	// (Modal, dialog & renderer senarai traveller — lihat sub-package
	//  traveller_list.js, di-include di atas.)
	// Resit rasmi Payment Entry — print format resit app.
	const pe_receipt_url = (name) =>
		'/api/method/frappe.utils.print_format.download_pdf?doctype='
		+ encodeURIComponent('Payment Entry') + '&name=' + encodeURIComponent(name)
		+ '&format=' + encodeURIComponent('Rarecation Receipt')
		+ '&no_letterhead=0';

	// PDF dokumen ERPNext — endpoint print standard frappe.
	const DOC_PRINT_FORMAT = {
		'Sales Order': 'Standard',
		'Sales Invoice': 'Standard',
		'Proforma Invoice': 'Proforma Invoice',
	};
	const doc_pdf_url = (doctype, name) =>
		'/api/method/frappe.utils.print_format.download_pdf?doctype='
		+ encodeURIComponent(doctype) + '&name=' + encodeURIComponent(name)
		+ '&format=' + encodeURIComponent(DOC_PRINT_FORMAT[doctype] || 'Standard')
		+ '&no_letterhead=0';

	// ── L3 Tab Documents — senarai SO/SI/PI + kad Payments. ──
	function render_bkg_documents(key) {
		const d = S.cache[key]?.profile;
		if (!d) return;
		const pane = $('#mba-detail').find(`.mba-group[data-item="${key}"] .mba-tab-pane[data-pane="doc"]`);

		const docs = [
			...(d.documents?.sales_orders || []).map((so) => ({
				type: 'Sales Order', doctype: 'Sales Order', name: so.name, key: 'so',
				is_addon: so.is_addon,
				date: so.transaction_date || (so.creation || '').slice(0, 10),
				currency: so.currency, amount: so.grand_total,
				status: so.status, docstatus: so.docstatus,
			})),
			...(d.documents?.sales_invoices || []).map((si) => ({
				type: 'Sales Invoice', doctype: 'Sales Invoice', name: si.name, key: 'si',
				date: si.posting_date, currency: si.currency,
				amount: si.grand_total, status: si.status, docstatus: si.docstatus,
			})),
			...(d.documents?.proforma_invoices || []).map((pf) => ({
				type: 'Proforma Invoice', doctype: 'Proforma Invoice', name: pf.name, key: 'pi',
				date: pf.proforma_date, currency: pf.currency,
				amount: pf.grand_total, status: pf.status, docstatus: pf.docstatus,
				pdf: pf.proforma_pdf,
			})),
		].sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));

		const slug = (t) => t.toLowerCase().replace(/ /g, '-');
		const items = docs.map((doc) => `
			<div class="mba-docrow mba-docitem" data-type="${doc.key}" data-route="${esc(doc.doctype)}/${esc(doc.name)}">
				<span class="mba-docitem-chip mba-docitem-chip--${doc.key}">${doc.key.toUpperCase()}</span>
				<div class="mba-docitem-main">
					<a href="/app/${slug(doc.doctype)}/${esc(doc.name)}">${esc(doc.name)}</a>
					${doc.is_addon ? badge(__('Addon'), 'gray') : ''}
					<div class="mba-docitem-sub">${__(doc.type)}${doc.date ? ' · ' + fmtDate(doc.date) : ''}</div>
				</div>
				<div class="mba-docitem-side">
					<div class="mba-docitem-amt">${fmtMoney(doc.amount, doc.currency)}</div>
					<div class="mba-docitem-badges">
						${docstatus_badge(doc.docstatus)}
						${doc.docstatus !== 2 ? badge(doc.status, SO_STATUS_COLORS[doc.status] || 'gray') : ''}
					</div>
				</div>
				<div class="mba-docitem-files">
					<a class="mba-doc-file-btn" href="${doc.pdf || doc_pdf_url(doc.doctype, doc.name)}" download
						title="${esc(__('Download document PDF'))}">⬇ PDF</a>
				</div>
			</div>`).join('');

		const typeCounts = { so: 0, si: 0, pi: 0 };
		docs.forEach((x) => { typeCounts[x.key] += 1; });
		const chips = docs.length ? `
			<div class="mba-bkg-chips">
				<button type="button" class="mba-doc-filter active" data-filter="all">${__('All')} · ${docs.length}</button>
				<button type="button" class="mba-doc-filter" data-filter="so">${__('Sales Order')} · ${typeCounts.so}</button>
				<button type="button" class="mba-doc-filter" data-filter="si">${__('Sales Invoice')} · ${typeCounts.si}</button>
				<button type="button" class="mba-doc-filter" data-filter="pi">${__('Proforma Invoice')} · ${typeCounts.pi}</button>
			</div>` : '';

		const docsCard = `
			<div class="mba-doc-card">
				<div class="mba-doc-card-head">
					<div class="mba-section-title">${__('Documents')}
						${docs.length ? `<span class="mba-count-pill">${docs.length}</span>` : ''}</div>
					${chips}
				</div>
				${docs.length ? `<div class="mba-doc-list">${items}</div>`
					: `<div class="mba-doc-empty">${__('No related documents (Sales Order / Invoice / Proforma) yet.')}</div>`}
			</div>`;

		// ----- Payments -----
		const tr = d.transactions || {};
		const pes = {};
		(tr.payments || []).forEach((pe) => {
			const e = pes[pe.name] || (pes[pe.name] = {
				name: pe.name, reference_date: pe.reference_date,
				creation: pe.creation, mode_of_payment: pe.mode_of_payment,
				reference_no: pe.reference_no, docstatus: pe.docstatus,
				paid_to: pe.paid_to, refs: [], amounts: {},
			});
			e.amounts[pe.currency] = round2((e.amounts[pe.currency] || 0) + pe.allocated_amount);
			const refLabel = (pe.reference_doctype === 'Sales Invoice' ? 'SI ' : 'SO ')
				+ pe.reference_name;
			if (!e.refs.includes(refLabel)) e.refs.push(refLabel);
		});
		const peRows = Object.values(pes);
		const fileMap = tr.payment_files || {};
		const fileBtns = (peName) => {
			const receipt = `
				<a class="mba-doc-file-btn" href="${pe_receipt_url(peName)}" download
					title="${esc(__('Download receipt PDF'))}">${__('Receipt')}</a>`;
			const files = fileMap[peName] || [];
			if (!files.length) return receipt;
			return receipt + files.map((f) => `
				<span class="mba-doc-file-actions">
					<button type="button" class="mba-doc-file-btn mba-file-view-btn"
						data-url="${esc(f.file_url)}" data-name="${esc(f.file_name)}"
						data-image="${f.is_image ? 1 : 0}"
						title="${esc(f.file_name)} · ${esc(__('Quick view'))}">👁</button>
					<a class="mba-doc-file-btn" href="${esc(f.file_url)}" download
						title="${esc(f.file_name)} · ${esc(__('Download attachment'))}">⬇</a>
				</span>`).join(' ');
		};
		const peItems = peRows.map((pe) => {
			const amt = Object.entries(pe.amounts)
				.map(([cur, v]) => fmtMoney(v, cur)).join('<br>');
			const statusMeta = PE_STATUS_META[pe.docstatus] || {};
			const meta = [
				pe.reference_date ? fmtDate(pe.reference_date) : fmtDate(pe.creation),
				pe.reference_no ? __('Ref') + ': ' + esc(pe.reference_no) : '',
				pe.paid_to ? esc(pe.paid_to) : '',
				pe.refs.length ? '→ ' + pe.refs.map(esc).join(' / ') : '',
			].filter(Boolean).join(' · ');
			return `
			<div class="mba-docitem" data-pe="${esc(pe.name)}">
				<span class="mba-docitem-chip mba-docitem-chip--pe">PE</span>
				<div class="mba-docitem-main">
					<a class="mba-pe-open" href="javascript:void(0)"
						title="${esc(__('Open payment entry details'))}">${esc(pe.name)}</a>
					<div class="mba-docitem-sub">${meta}</div>
				</div>
				<div class="mba-docitem-side">
					<div class="mba-docitem-amt">${amt}</div>
					${statusMeta.label ? `<div class="mba-docitem-badges">${badge(__(statusMeta.label), statusMeta.color)}</div>` : ''}
				</div>
				<div class="mba-docitem-files">${fileBtns(pe.name)}</div>
			</div>`;
		}).join('');

		// Kepala kad Payments — SUBTITLE tajuk = Total Paid + Last payment;
		// paysum (kanan) = badge Verified + dropdown Payment (Register /
		// Payment Request Link) rapat ke kanan.
		const booking = (d.profile || {}).name;
		const has_due = hasBalance((d.profile || {}).money_by_currency || []);
		const pesOk = peRows.filter((pe) => pe.docstatus !== 2);
		let paySubtitle = '';
		let verifiedBadge = '';
		if (pesOk.length) {
			const totals = {};
			pesOk.forEach((pe) => Object.entries(pe.amounts).forEach(([cur, v]) => {
				totals[cur] = round2((totals[cur] || 0) + v);
			}));
			const total = Object.entries(totals).map(([cur, v]) => fmtMoney(v, cur)).join(' · ');
			const verified = pesOk.filter((pe) => pe.docstatus === 1).length;
			paySubtitle = `<span class="mba-doc-paysub">${__('Total Paid')} <b>${total}</b>
				· ${__('Last payment')} <b>${fmtDate(pesOk[0].date)}</b></span>`;
			verifiedBadge = badge(verified + '/' + pesOk.length + ' ' + __('Verified'),
				verified === pesOk.length ? 'green' : 'yellow');
		}
		const payMenu = `
			<button type="button" class="btn btn-default btn-xs mba-pay-menu-btn" aria-haspopup="menu"
				title="${esc(__('Payment actions — register a payment or generate a payment link'))}">
				${__('Payment')} ${frappe.utils.icon('chevron-down', 'xs')}</button>`;
		const paysum = `<div class="mba-doc-paysum">${verifiedBadge}${payMenu}</div>`;
		const payCard = `
			<div class="mba-doc-card">
				<div class="mba-doc-card-head">
					<div class="mba-section-title">${__('Payments')}
						${peRows.length ? `<span class="mba-count-pill">${peRows.length}</span>` : ''}
						${paySubtitle}</div>
					${paysum}
				</div>
				${peRows.length ? `<div class="mba-doc-list">${peItems}</div>`
					: `<div class="mba-doc-empty">${__('No payment entry linked to this booking.')}</div>`}
			</div>`;

		pane.html(docsCard + payCard);
		// Baris PE → MODAL maklumat + pratonton lampiran (bukan navigasi
		// borang doctype — borang dibuka melalui butang footer modal).
		// Ikat pada BARIS sahaja — klik pada pautan dalam baris menggelembung
		// ke sini (pengikat atas pautan & baris serentak akan membuka modal
		// dua kali).
		pane.find('.mba-docitem[data-pe]').on('click', function (ev) {
			if ($(ev.target).closest('.mba-doc-file-btn, .mba-file-view-btn, .mba-reg-file-del, a[target="_blank"]').length) return;
			const pe = String($(this).data('pe') || '');
			if (pe) show_payment_entry_modal(booking, pe);
		});
		const $payMenuBtn = pane.find('.mba-pay-menu-btn');
		if ($payMenuBtn.length) {
			new frappe.ui.Dropdown({
				trigger: $payMenuBtn,
				align: 'end',
				options: [
					{ label: __('Register Payment'), icon: 'plus',
						description: __('Record a payment received from the customer'),
						disabled: !can_create_pe() || !has_due,
						onclick: () => open_register_payment_dialog(booking) },
					{ label: __('Payment Request Link'), icon: 'credit-card',
						description: __('Generate and share a payment link for the outstanding balance'),
						disabled: !has_due,
						onclick: () => open_payment_link_dialog(booking) },
				],
			});
		}
	}

	// ── L3 Tab Others — diskaun, affiliate, komisen, audit. ──
	function render_bkg_others(key) {
		const d = S.cache[key]?.profile;
		if (!d) return;
		const p = d.profile || {};
		const pane = $('#mba-detail').find(`.mba-group[data-item="${key}"] .mba-tab-pane[data-pane="other"]`);
		const row = (k, v, cls) => `
			<div class="mba-bkg-card-row${cls ? ' ' + cls : ''}"><span>${k}</span><span>${v}</span></div>`;

		// Diskaun penuh — satu currency (discount_currency = SO utama).
		let dscCard = '';
		{
			const cur = p.discount_currency || S.currency;
			const total = round2((p.voucher_discount || 0) + (p.price_rule_discount || 0) + (p.referral_discount || 0));
			if ((total > 0) || (p.pre_discount_total > 0)) {
				const money = (v) => fmtMoney(v || 0, cur);
				dscCard = bkg_section(__('Discount Information'), '',
					`<div class="mba-bkg-card">
						${row(__('Pre-Discount Total'), money(p.pre_discount_total), 'is-strong')}
						${row(__('Voucher Discount'), money(p.voucher_discount))}
						${row(__('Price Rule Discount'), money(p.price_rule_discount))}
						${row(__('Referral Discount'), money(p.referral_discount))}
						<div class="mba-bkg-card-row is-dsc"><span>${__('Total Discount')}</span><span>${total > 0 ? '− ' + money(total) : money(0)}</span></div>
					</div>`);
			}
		}

		// Profil affiliate ringkas + butang Call/WhatsApp.
		let affCard = '';
		{
			const a = d.affiliate_info;
			if (a) {
				affCard = bkg_section(__('Affiliate Profile'), '',
					`<div class="mba-bkg-card">
						<div class="mba-bkg-card-title">
							<a href="/app/affiliate-profile/${esc(a.name)}">${esc(a.full_name || a.name)}</a>
						</div>
						${a.referral_code ? row(__('Referral Code'), esc(a.referral_code)) : ''}
						${a.email ? row(__('Email'), '✉ ' + esc(a.email)) : ''}
						${a.phone ? row(__('Phone'), '☎ ' + esc(a.phone)) : ''}
						${a.phone ? `<div class="mba-bkg-card-actions">${call_wa_btns(a.phone)}</div>` : ''}
					</div>`);
			}
		}

		// Komisen affiliate — Affiliate Commission berpaut ke SO booking.
		let commissionCard = '';
		{
			const rows = d.commissions || [];
			if (rows.length) {
				const received = {};
				rows.forEach((c) => {
					if (c.status === 'Paid' && !c.is_reversal) {
						received[c.currency] = round2((received[c.currency] || 0) + c.amount);
					}
				});
				const receivedHtml = Object.entries(received).map(([cur, v]) => fmtMoney(v, cur)).join(' · ');
				const body = rows.map((c) => `
					<tr data-route="Affiliate Commission/${esc(c.name)}">
						<td><a href="/app/affiliate-commission/${esc(c.name)}">${esc(c.name)}</a>
							<div class="mba-cell-sub">${__('From')} <a href="/app/sales-order/${esc(c.sales_order)}">${esc(c.sales_order)}</a></div></td>
						<td class="num">${c.rate ? c.rate + '%' : '—'}${c.base ? ' · ' + esc(c.base) : ''}</td>
						<td class="num">${c.is_reversal ? '− ' + fmtMoney(c.amount, c.currency) : fmtMoney(c.amount, c.currency)}</td>
						<td>${c.is_reversal ? badge(__('Reversal'), 'red') : badge(__(c.status), COMMISSION_STATUS_COLORS[c.status] || 'gray')}</td>
					</tr>`).join('');
				commissionCard = bkg_section(__('Commission Received'), rows.length,
					`<div class="mba-table-wrap">
						<table class="mba-table">
							<thead><tr>
								<th>${__('Commission')}</th>
								<th class="num">${__('Rate')}</th>
								<th class="num">${__('Amount')}</th>
								<th>${__('Status')}</th>
							</tr></thead>
							<tbody>${body}</tbody>
						</table>
					</div>${receivedHtml ? `<div class="mba-bkg-dsc-note">${__('Received (Paid)')}: <b>${receivedHtml}</b></div>` : ''}`);
			}
		}

		const auditCard = bkg_section(__('Audit'), '',
			`<div class="mba-bkg-card">
				${row(__('Booked By'), esc(p.booked_by || '—'))}
				${row(__('Created'), esc(fmtDateTime(p.creation)))}
				${row(__('Modified'), esc(fmtDateTime(p.modified)))}
				${p.company ? row(__('Company'), esc(p.company)) : ''}
			</div>`);

		const duo = (dscCard && affCard)
			? `<div class="mba-bkg-others-grid">
				<div>${dscCard}</div><div>${affCard}</div></div>`
			: (dscCard + affCard);

		pane.html(duo + commissionCard + auditCard);
	}

	// Modal preview Trip — iframe laman web trip.
	const show_trip_preview = (url, title) => {
		const d = new frappe.ui.Dialog({ title: title || __('Trip Preview'), size: 'extra-large' });
		d.$body.html(`
			<div class="mba-file-viewer">
				<iframe class="mba-file-frame" src="${esc(url)}" title="${esc(title || '')}"></iframe>
				<div class="mba-file-actions">
					<a class="btn btn-default btn-sm" href="${esc(url)}" target="_blank" rel="noopener">${__('Open in new tab')}</a>
				</div>
			</div>`);
		d.show();
	};
