	/* ════════════════════════════════════════════════════════════════════
	   [DEPREKAT Nov 2026 — TIDAK DI-INCLUDE LAGI] tm_booking_mgmt.js
	   ════════════════════════════════════════════════════════════════════
	   View "Booking Management" dalam page travel-manager diganti VIEW
	   PENUH Booking Management (v68 — tm_booking.js + traveller_list.js +
	   rooms_list.js + rooming_board.js, dipindah daripada page berasingan
	   travel_management/booking_management yang dahulu menggantikan
	   manage_booking_app). Router travel_manager alih URL
	   travel-manager/booking-management ke route 'booking'. Fail ini
	   dikekalkan di disk sehingga fasa buang (bersama page lama
	   manage_booking_app).
	   ════════════════════════════════════════════════════════════════════ */

	/* Kandungan asal (senarai booking individu + tapisan status + aliran
	   status + dialog Kuota & Harga per offer): */

		// ════════════ BOOKING MANAGEMENT (individual) ════════════
		const BKG_STATUSES = ['Pending', 'Accepted', 'Processing', 'Confirmed', 'Completed', 'Abandoned', 'Cancelled'];

		async function load_bookings() {
			breadcrumb([
				{ label: 'Travel Manager', route: ['travel-manager'] },
				{ label: 'Booking Management' },
			]);
			$body.html(`
				<div class="d-flex flex-wrap gap-2 align-items-center mb-0">
					<input class="form-control form-control-sm w-auto tm-search tm-bkg-search"
						placeholder="Search booking/customer/trip…"
						value="${esc(state.bkg_search)}" aria-label="Search bookings">
				</div>
				<div class="d-flex flex-nowrap gap-2 overflow-auto py-1 mb-3" role="group" aria-label="Filter by status">
					${['All'].concat(BKG_STATUSES).map((s) =>
						`<button class="btn btn-xs shrink-0 tm-bst ${state.bkg_status === s ? 'btn-primary' : 'btn-default'}"
							data-s="${s}">${s}</button>`).join('')}
				</div>
				<div class="tm-bkg">${loading()}</div>
			`);
			$body.find('.tm-bkg-search').on('input', frappe.utils.debounce(function () {
				state.bkg_search = $(this).val().toLowerCase(); render_bookings();
			}, 300));
			$body.find('.tm-bst').on('click', function () {
				state.bkg_status = $(this).data('s'); render_bookings();
			});

			const data = await hub('get_booking_kanban', {});
			state.bkg_data = data;
			render_bookings();
		}

		function render_bookings() {
			const $box = $body.find('.tm-bkg');
			if (!$box.length) return;
			const cols = state.bkg_data?.columns || {};
			const q = state.bkg_search;
			let rows = '';
			let cards = '';
			let shown = 0;
			BKG_STATUSES.forEach((s) => {
				if (state.bkg_status !== 'All' && state.bkg_status !== s) return;
				(cols[s] || []).forEach((b) => {
					const hay = [b.name, b.customer_name, b.trip_name, b.departure_date, b.trip_date]
						.join(' ').toLowerCase();
					if (q && hay.indexOf(q) === -1) return;
					shown++;
					rows += `
						<tr data-booking="${esc(b.name)}">
							<td><strong>${esc(b.name)}</strong></td>
							<td>${esc(b.customer_name || '')}</td>
							<td>${esc(b.trip_name || '')}</td>
							<td>${esc(b.departure_date || b.trip_date || '')}</td>
							<td class="text-right">${money(b.total_amount)}</td>
							<td>${badge(b.status, BKG_COLOR[b.status] || C.gray)}</td>
							<td class="text-nowrap">${next_status_options(b.status)}</td>
						</tr>`;
					cards += `
						<div class="card" data-booking="${esc(b.name)}">
							<div class="card-body py-3">
								<div class="d-flex align-items-start gap-2">
									<div class="flex-fill min-w-0">
										<div class="font-weight-bold">${esc(b.name)}</div>
										<div class="text-muted text-small">${esc(b.customer_name || '')}</div>
									</div>
									${badge(b.status, BKG_COLOR[b.status] || C.gray)}
								</div>
								<div class="text-muted text-small mt-2">
									${esc(b.trip_name || '')}${b.departure_date || b.trip_date
										? ' · ' + esc(b.departure_date || b.trip_date) : ''}</div>
								<div class="d-flex align-items-center flex-wrap gap-2 border-top mt-2 pt-2 text-muted text-small">
									<span>Amount</span>
									<span class="ml-auto"><b class="text-body">${money(b.total_amount)}</b></span>
								</div>
								<div class="d-flex flex-wrap gap-2 border-top mt-2 pt-2">${next_status_options(b.status)}</div>
							</div>
						</div>`;
				});
			});
			$box.html(`
				${shown ? `
				<div class="d-flex flex-column gap-2 d-lg-none">${cards}</div>
				<div class="d-none d-lg-block">
					<table class="table table-sm table-hover mb-0">
						<thead><tr><th>Booking</th><th>Customer</th><th>Trip</th>
							<th>Departure</th><th class="text-right">Amount</th>
							<th>Status</th><th>Actions</th></tr></thead>
						<tbody>${rows}</tbody>
					</table>
				</div>
				<p class="text-muted small mt-2">${shown} bookings</p>`
				: `<p class="text-muted small text-center p-4">No matching bookings.</p>`}
			`);
			$box.find('.tm-next').on('click', function () {
				// cards (div) and table rows (tr) both carry data-booking
				const booking = $(this).closest('[data-booking]').data('booking');
				const next = $(this).data('next');
				frappe.confirm(`Change booking ${booking} status to "${next}"?`, async () => {
					try {
						await hub('update_booking_status', { booking_name: booking, new_status: next });
						frappe.show_alert({ message: 'Booking status updated', indicator: 'green' });
						load_bookings();
					} catch (err) { /* frappe already shows it */ }
				});
			});
		}

		// ── F5: Quota & Prices dialog (flag prerequisite — fill allotment without a DocType) ──
		// NOTA (Nov 2026): B2B partner quota DIBUANG daripada development ini
		// — inventori tidak lagi ada kolum Reserved For Partner.
		function commercial_dialog(offer, onDone) {
			api('get_offer_commercial', { offer }).then((data) => {
				const inv = data?.inventory || [];
				const pmx = data?.price_matrix || [];
				const pt = data?.payment_terms || {};
				const d = new frappe.ui.Dialog({
					title: 'Quota & Prices — ' + offer, size: 'large',
				});
				d.$body.html(`
					<div id="tm-cd-payment">
						${secTitle('Payment Terms', '(Fasa A — 0 = global default Travel Settings)')}
						<div id="tm-cd-terms-row1" class="d-flex flex-wrap gap-3 mb-1">
							<div style="flex:0 0 170px">
								<label class="text-muted d-block" for="tm-deposit-pct">Deposit %</label>
								<input class="form-control form-control-sm" id="tm-deposit-pct"
									type="number" min="0" max="100" step="1"
									value="${pt.deposit_percent || 0}">
							</div>
							<div style="flex:0 0 240px">
								<label class="text-muted d-block" for="tm-final-days">Final Payment (hari sebelum berlepas)</label>
								<input class="form-control form-control-sm" id="tm-final-days"
									type="number" min="0" step="1"
									value="${pt.final_payment_days || 0}">
							</div>
							<div class="flex-fill text-muted small align-self-center">
								Deposit semasa booking; baki lengkap sebelum berlepas.
								Booking dalam tetingkap final = bayar penuh serta-merta.
							</div>
						</div>
						<div id="tm-cd-terms-row2" class="d-flex flex-wrap gap-3 mt-2">
							<div style="flex:0 0 170px">
								<label class="text-muted d-block" for="tm-sale-mode">Sale Mode (Fasa C)</label>
								<select class="form-control form-control-sm" id="tm-sale-mode">
									${['Public', 'Group Block', 'Full Charter', 'Private'].map((m) =>
										`<option value="${m}" ${data?.sale_mode === m ? 'selected' : ''}>${m}</option>`).join('')}
								</select>
							</div>
							<div style="flex:0 0 240px">
								<label class="text-muted d-block" for="tm-block-code">Group Block Code</label>
								<input class="form-control form-control-sm" id="tm-block-code"
									type="text" maxlength="60"
									value="${esc(data?.group_block_code || '')}"
									${data?.sale_mode === 'Group Block' ? '' : 'disabled'}>
							</div>
						</div>
					</div>
					<div id="tm-cd-inventory" class="mt-3">
						${secTitle('Inventory', '(allotment editable; sold read-only)')}
						${data?.inventory_source === 'cabin_rates' ? `
						<div class="alert alert-secondary text-muted py-1 px-2 mb-2">
							⚓ <strong>Kolam kabin schedule</strong> — kabin fizikal dikongsi semua offer sailing
							${data?.sailing_label ? `<strong> ${esc(data.sailing_label)}</strong>` : ''}.
							Kuota diisi SEKALI di sini, bukan per offer.
						</div>` : ''}
						<table class="table table-sm mb-0">
							<thead><tr><th>Key</th><th style="width:110px">Allotment</th>
								<th>Sold</th><th>Available</th></tr></thead>
							<tbody>${inv.map((r) => `
								<tr>
									<td>${esc(r.inventory_key)}</td>
									<td><input class="form-control form-control-sm tm-alloc"
										data-name="${esc(r.name)}" data-key="${esc(r.inventory_key)}"
										type="number" min="0" value="${r.allotment || 0}"></td>
									<td>${r.sold || 0}</td>
									<td>${r.available ?? ((r.allotment || 0) - (r.sold || 0))}</td>
								</tr>`).join('')}</tbody>
						</table>
					</div>
					<div id="tm-cd-prices" class="mt-3">
						${secTitle('Price Matrix', '(room category × slot — sumber harga checkout)')}
						${(pmx.length) ? `
						<table class="table table-sm mb-0">
							<thead><tr><th>Room Category</th>
								<th style="width:90px">Adult</th><th style="width:90px">Single</th>
								<th style="width:90px">Upper</th><th style="width:90px">Children</th>
								<th style="width:90px">Toddler</th><th style="width:90px">Infant</th></tr></thead>
							<tbody>${pmx.map((r) => `
								<tr>
									<td><strong>${esc(r.category_name || r.category_code)}</strong>
										<span class="text-muted text-small">${esc(r.category_code || '')}</span></td>
									${[['price_adult'], ['price_adult_single'], ['price_upperberth'],
										['price_children'], ['price_toddler'], ['price_infant']].map(([col]) => `
									<td><input class="form-control form-control-sm tm-mx"
										data-code="${esc(r.category_code || '')}" data-col="${col}"
										type="number" min="0" step="0.01"
										value="${r[col] != null ? r[col] : ''}" placeholder="—"></td>`).join('')}
								</tr>`).join('')}</tbody>
						</table>` : '<p class="text-muted mt-2 mb-0">No price rows — isi melalui halaman pakej (Extract & Import).</p>'}
					</div>
				`);
				d.$body.find('#tm-sale-mode').on('change', function () {
					d.$body.find('#tm-block-code').prop(
						'disabled', $(this).val() !== 'Group Block');
				});

				d.set_primary_action(__('Save'), async () => {
					const invRows = [];
					d.$body.find('.tm-alloc').each(function () {
						const nm = $(this).data('name');
						invRows.push({
							name: nm,
							inventory_key: $(this).data('key'),
							allotment: parseInt($(this).val() || 0, 10),
						});
					});
					const priceRows = [];
					d.$body.find('.tm-mx').each(function () {
						const code = $(this).data('code');
						if (!code) return;
						priceRows.push({
							pricing_for_class: code,
							[$(this).data('col')]: $(this).val() === ''
								? null : parseFloat($(this).val() || 0),
						});
					});
					try {
						await api('save_offer_inventory', { offer, rows: JSON.stringify(invRows) });
						await api('save_offer_price_matrix', { offer, rows: JSON.stringify(priceRows) });
						// Fasa A (G1): terma bayaran offer — deposit % + final payment.
						await api('save_offer_payment_terms', {
							offer,
							deposit_percent: parseFloat(d.$body.find('#tm-deposit-pct').val() || 0),
							final_payment_days: parseInt(d.$body.find('#tm-final-days').val() || 0, 10),
						});
						// Fasa C: mod jualan + kod blok kumpulan.
						await api('save_offer_grouping', {
							offer,
							sale_mode: d.$body.find('#tm-sale-mode').val(),
							group_block_code: d.$body.find('#tm-block-code').val() || '',
						});
						frappe.show_alert({ message: 'Quota, prices, payment terms & grouping saved', indicator: 'green' });
						d.hide();
						onDone && onDone();
					} catch (e) { /* frappe already shows it */ }
				});
				d.show();
			});
		}
