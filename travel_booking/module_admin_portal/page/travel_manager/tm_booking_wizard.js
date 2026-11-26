	/* ════════════════════════════════════════════════════════════════════
	   SEKSYEN: BOOKING WIZARD (tm_booking_wizard.js)
	   ════════════════════════════════════════════════════════════════════
	   Wizard booking DESK — route sendiri /booking/new (bukan modal, corak
	   wizard trip baru): langkah Bilik & Tetamu → Add-on → Pelanggan →
	   Bayaran → ringkasan keputusan. Workflow & rules MIRIP 100% wizard
	   portal /booknow — perbezaan hanya pintu masuk:
	     - staf desk beringin (on_behalf) → OTP email customer dilangkau,
	       Booking.booking_channel "Staff", booked_by = session user;
	     - struktur produk OFFER SAHAJA (Package Offer, flag
	       use_package_offers) — tiada pemilih legacy TGD/pakej;
	     - bayaran: Online (Stripe link) / Manual Transfer / Pay Later.
	   SEMUA harga/kapasiti/discaun di-re-price server-side oleh
	   desk_booking.create_desk_booking → booking_engine._confirm_booking_impl
	   (pipeline portal yang sama) — angka paparan di sini PANDUAN sahaja.
	   Di-include ke dalam scope IIFE page (render_include) — boleh rujuk
	   closure shell ($body, breadcrumb, esc, card, badge, C, fmtNum, dsb).
	   API AWAM: load_booking_wizard() (router booking/new).
	   ════════════════════════════════════════════════════════════════════ */

		// ════════════ BOOKING WIZARD (4 langkah + skrin keputusan) ════════════
		// Endpoint desk (role-gated MANAGE_TRIP_ROLES) + endpoint portal yang
		// sedia ada (whitelisted — dibaca langsung, TIADA duplikasi logik).
		function load_booking_wizard() {
			const dbk = (method, args = {}) =>
				frappe.call({ method: 'travel_booking.api.desk_booking.' + method,
					args, quiet: true }).then(r => r?.message ?? null);
			const pbk = (method, args = {}) =>
				frappe.call({ method, args, quiet: true }).then(r => r?.message ?? null);

			// STATE wizard — closure biasa (tiada persistence; re-enter route
			// = wizard baru, corak tm_new_trip_wizard).
			const wiz = {
				step: 1, busy: false, result: null,
				ctx: null,            // desk_booking.get_wizard_context
				pay: null,            // pricing.get_payment_settings
				salesPersons: [],     // pricing.get_sales_persons
				labels: { cruise: {}, non_cruise: {} },
				trips: [], trip: '',  // penapis trip (opsyenal)
				offers: [], q: '',
				offer: null,          // baris Package Offer terpilih
				details: null,        // pricing.get_booking_details (offer-mode)
				rooms: [],            // [{room_category, guests:[{slot,category}], room_privacy}]
				addonQty: {},         // {addon_package: qty}
				addons: null,         // katalog get_wizard_addons
				billing: { email: '', full_name: '', phone: '', address_line1: '',
					city: '', postcode: '', state: '', country: '' },
				countries: [],
				voucher: { code: '', checked: null, applied: '' },
				affiliate: { code: '', checked: null, applied: '' },
				payment_method: 'Pay Later', payment_type: 'Deposit',
				bank: { ref: '', date: '', note: '' }, receipt: null,
				sales_persons: [], customer_message: '', terms_ok: false,
			};

			const round2 = (n) => Math.round((parseFloat(n || 0) + Number.EPSILON) * 100) / 100;
			const wbzMoney = (n) => (wiz.offer?.currency || 'MYR') + ' '
				+ parseFloat(n || 0).toLocaleString('en-MY',
					{ minimumFractionDigits: 2, maximumFractionDigits: 2 });
			const isCruise = () => !!(wiz.details?.trip?.is_a_cruise_trip);
			const cabMap = () => Object.fromEntries(
				(wiz.details?.cabins || []).map((c) => [c.room_category, c]));
			const gCount = (room, slot) =>
				room.guests.filter((g) => g.slot === slot).length;
			const roomPax = (room) => room.guests.length;

			// ── Stepper + baris aksi (corak tm_new_trip_wizard) ──────────────
			const WZ_STEPS = ['Bilik & Tetamu', 'Add-on', 'Pelanggan', 'Bayaran'];
			const stepDots = () => WZ_STEPS.map((lbl, i) => {
				const n = i + 1;
				const done = wiz.result || n < wiz.step;
				const cur = !wiz.result && n === wiz.step;
				const cls = done ? 'text-success'
					: cur ? 'text-primary font-weight-bold' : 'text-muted';
				const mark = (done || cur) ? '●' : '○';
				return `<span class="text-nowrap ${cls}">${mark} ${n} ${esc(lbl)}</span>`;
			}).join('<span class="text-muted" aria-hidden="true">—</span>');

			const actionRow = (primary) => `
				<div class="d-flex flex-wrap gap-2 align-items-center mt-3">
					${wiz.step > 1 && !wiz.result
						? '<button class="btn btn-default btn-sm wbz-back">← Back</button>' : ''}
					<button class="btn btn-default btn-sm wbz-cancel">Cancel</button>
					${primary ? `<button class="btn btn-primary btn-sm ml-auto wbz-next"
						${wiz.busy ? 'disabled' : ''}>${primary}</button>` : ''}
				</div>`;

			// ── Kadar & jumlah (mirror client booknow.js — PANDUAN sahaja;
			//    harga muktamad di-re-price dalam _confirm_booking_impl) ─────
			// Kadar satu baris tetamu — mirror pricing._price_selection:
			// cruise main sorangan = price_adult_single; main ≥2 = price_adult
			// (semua baris main bertukar bila mg 1↔2); extra bed = upperberth
			// (cruise) / children (non-cruise); infant = price_infant.
			// Harga dari get_booking_details SUDAH termasuk surcaj addon
			// offer (addon_price_matrix) — ia harga jualan berkesan.
			const rateOf = (room, g) => {
				const cab = cabMap()[room.room_category];
				const p = cab?.pricing || {};
				const o = cab?.original_pricing || null;
				const pick = (k) => ({ rate: parseFloat(p[k] || 0),
					orig: o ? parseFloat(o[k] || 0) : null });
				if (g.slot === 'infant') return pick('price_infant');
				if (isCruise()) {
					if (g.slot === 'extra_bed') return pick('price_upperberth');
					return gCount(room, 'main') === 1
						? pick('price_adult_single') : pick('price_adult');
				}
				if (g.slot === 'extra_bed') return pick('price_children');
				return pick('price_adult');
			};
			// Keterangan slot tetamu — label dari Travel Settings
			// price_category_labels (fetch_price_labels), fallback teks ringkas.
			const slotLabel = (room, g) => {
				const L = wiz.labels[isCruise() ? 'cruise' : 'non_cruise'] || {};
				if (g.slot === 'infant') return L.price_infant || 'Infant';
				if (isCruise()) {
					if (g.slot === 'extra_bed') return L.price_upperberth || 'Extra Bed';
					return L.price_adult || 'Main Adult';
				}
				if (g.slot === 'extra_bed') return L.price_children || 'Children';
				return L.price_adult || 'Adult';
			};

			// Terma bayaran berkesan — mirror _effective_payment_terms:
			// override Package Offer → default Travel Settings (ctx bootstrap).
			// Medan offer kosong/0 TIDAK mematikan fallback global (offer
			// ialah override, bukan pintu mati — selari impl server).
			const wTerms = () => {
				const o = wiz.offer || {};
				const pct = parseFloat(o.deposit_percent) > 0
					? parseFloat(o.deposit_percent)
					: (wiz.ctx.default_deposit_percent || 0);
				const fd = parseInt(o.final_payment_days, 10) > 0
					? parseInt(o.final_payment_days, 10)
					: (wiz.ctx.default_final_payment_days || 0);
				return { pct, fd };
			};
			// Dalam tetingkap bayaran akhir (departure − N ≤ hari ini)?
			const inFinalWindow = () => {
				const { fd } = wTerms();
				const dep = wiz.details?.trip_group_date?.departure_date;
				if (!dep || !fd) return false;
				return frappe.datetime.get_diff(dep, frappe.datetime.get_today()) <= fd;
			};
			// Mirror _deposit_or_full — deposit ATAU penuh (panduan UI).
			const depositOrFull = (net) => {
				const { pct, fd } = wTerms();
				const dep = round2(net * (pct / 100));
				if (pct <= 0 || dep >= net) return net;
				if (!wiz.details?.trip_group_date?.departure_date || !fd) return net;
				if (inFinalWindow()) return net;
				return dep;
			};

			const totals = () => {
				let grand = 0, retail = 0, hasSlash = false;
				wiz.rooms.forEach((r) => r.guests.forEach((g) => {
					const rt = rateOf(r, g);
					grand += rt.rate;
					if (rt.orig != null && rt.orig !== rt.rate) {
						retail += rt.orig; hasSlash = true;
					} else retail += rt.rate;
				}));
				grand = round2(grand);
				retail = hasSlash ? round2(retail) : null;
				const v = wiz.voucher.checked?.valid
					? round2(wiz.voucher.checked.discount_amount) : 0;
				const refPct = wiz.affiliate.checked?.valid
					? (parseFloat(wiz.affiliate.checked.discount_percent) || 0) : 0;
				// Tier B mirror portal: referral atas baki SELEPAS voucher.
				const ref = round2((grand - v) * refPct / 100);
				const net = round2(grand - v - ref);
				return { grand, retail, v, ref, refPct, net };
			};

			// ── Peraturan kapasiti per slot (mirror pricing._validate_selection_
			//    capacity + booknow.js roomSlotCaps) ────────────────────────────
			// Cruise (model SLOT): main 1..capacity; extra bed HANYA bila main
			// penuh; infant bila main ≥1; max_capacity==0 = UNLIMITED.
			// Non-cruise (model UMUR): adult/children kongsi max_capacity.
			const slotCaps = (room) => {
				const cab = cabMap()[room.room_category];
				const none = { main: 0, extra_bed: 0, infant: 0 };
				if (!cab) return none;
				const capacity = cab.capacity || 0;
				const unlimited = cab.max_capacity === 0;
				const maxCap = unlimited ? Infinity : (cab.max_capacity || capacity);
				const mainCap = capacity > 0 ? capacity : Infinity;
				const mg = gCount(room, 'main'), eb = gCount(room, 'extra_bed');
				const inf = gCount(room, 'infant');
				const caps = {};
				if (isCruise()) {
					caps.main = Math.max(0, Math.min(mainCap, maxCap - eb - inf) - mg);
					const ebAllowed = (capacity > 0) ? (mg === capacity) : (mg >= 1);
					caps.extra_bed = ebAllowed
						? Math.max(0, maxCap - mg - inf - eb) : 0;
				} else {
					caps.main = Math.max(0, maxCap - eb - inf - mg);
					caps.extra_bed = (mg >= 1)
						? Math.max(0, maxCap - mg - inf - eb) : 0;
				}
				caps.infant = (mg >= 1)
					? Math.max(0, maxCap - mg - eb - inf) : 0;
				return caps;
			};
			// Baki kabin kolam kontrak sailing per kategori (null = offer
			// darat, tiada had) — had bilangan bilik SEMASA pemilihan.
			const poolLeft = (cat) => {
				const cab = cabMap()[cat];
				if (!cab || cab.pool_cabins_left == null) return Infinity;
				const used = wiz.rooms.filter((r) => r.room_category === cat).length;
				return Math.max(0, cab.pool_cabins_left - used);
			};
			const maxCabins = () => wiz.ctx.max_cabins > 0
				? wiz.ctx.max_cabins : Infinity;

			// Eligible pax add-on per-pax = main + extra bed (infant
			// dilangkau — mirror _eligible_pax dalam impl).
			const eligiblePax = () => wiz.rooms.reduce((sum, r) =>
				sum + gCount(r, 'main') + gCount(r, 'extra_bed'), 0);

			// ── RENDER ────────────────────────────────────────────────────────
			const render = () => {
				const $b = $body;
				if (wiz.result) { renderResult(); return; }
				$b.html(`
					<div class="wbz-wrap">
						<div class="d-flex flex-wrap gap-2 align-items-center mb-2">
							<div class="d-flex flex-wrap gap-2 align-items-center wbz-steps">${stepDots()}</div>
							<span class="ml-auto text-muted small">${esc(wiz.offer
								? `${wiz.offer.offer_label} · ${frappe.datetime.str_to_user(wiz.offer.departure_date)}`
								: 'Pilih offer untuk mula')}</span>
						</div>
						<div id="wbz-body"></div>
					</div>`);
				const $out = $b.find('#wbz-body');
				if (wiz.step === 1) $out.html(renderStep1());
				else if (wiz.step === 2) $out.html(renderStep2());
				else if (wiz.step === 3) $out.html(renderStep3());
				else $out.html(renderStep4());
				wire();
			};

			// ── STEP 1 — Bilik & Tetamu ──────────────────────────────────────
			const renderStep1 = () => {
				let html = '';
				// Gate struktur/on-behalf — sekat awal dengan mesej jelas.
				if (!wiz.ctx.use_package_offers) {
					html += card(12, 'Sekatan', `
						<div class="alert alert-warning mb-0">
							<strong>Struktur baharu tidak aktif.</strong>
							Wizard desk ini hanya menyokong <em>Package Offer</em>.
							Aktifkan <code>Travel Settings → Use Package Offers</code>
							terlebih dahulu.
						</div>`);
					return html + actionRow(null);
				}
				if (!wiz.ctx.on_behalf.ok) {
					html += card(12, 'Sekatan', `
						<div class="alert alert-warning mb-0">
							<strong>Role anda belum didaftarkan untuk booking
							on-behalf.</strong> Tambah role
							<code>${esc(frappe.session.user)}</code> dalam
							<code>Travel Settings → On-Behalf Booking Roles</code>
							(channel <em>Staff</em>), atau jalankan
							<code>maintenance.ensure_default_records()</code>.
							Tanpa itu, gate OTP server akan menolak tempahan.
						</div>`);
					return html + actionRow(null);
				}

				// ── Pemilih offer ──
				const tripOpts = ['<option value="">Semua Trip</option>']
					.concat(wiz.trips.map((t) =>
						`<option value="${esc(t.name)}" ${t.name === wiz.trip ? 'selected' : ''}>${esc(t.trip_name || t.name)}</option>`));
				const offerRows = wiz.offers.length ? wiz.offers.map((o) => `
					<tr>
						<td><strong>${esc(o.offer_label)}</strong>
							${o.legacy_trip_package ? '' : '<span class="badge badge-light ml-1">identiti-sendiri</span>'}
							<div class="text-muted small">${esc(o.trip_name || '')}</div></td>
						<td class="wbz-nowrap">${frappe.datetime.str_to_user(o.departure_date)}</td>
						<td>${esc(o.currency || '')}</td>
						<td class="text-right wbz-nowrap">
							<button class="btn btn-primary btn-sm wbz-pick-offer"
								data-offer="${esc(o.name)}">Pilih</button></td>
					</tr>`).join('') : '';
				html += card(12, '1 · Trip & Package Offer', `
					<div class="d-flex flex-wrap gap-2 align-items-center mb-2">
						<select class="form-control form-control-sm wbz-trip-sel"
							style="max-width:280px" title="Penapis trip">
							${tripOpts.join('')}
						</select>
						<input class="form-control form-control-sm wbz-offer-q"
							style="max-width:240px" placeholder="Cari offer / tarikh berlepas…"
							value="${esc(wiz.q)}">
						<span class="text-muted small ml-auto">${wiz.offers.length
							? wiz.offers.length + ' offer aktif' : ''}</span>
					</div>
					${offerRows ? `
					<div class="table-responsive"><table class="table table-sm table-hover mb-0">
						<thead><tr><th>Offer</th><th>Berlepas</th><th>CCY</th><th></th></tr></thead>
						<tbody>${offerRows}</tbody>
					</table></div>`
					: `<p class="text-muted small mb-0">Tiada offer aktif akan datang
						${wiz.trip ? 'untuk trip ini' : ''}. Offer mesti
						<em>Active</em> dengan tarikh berlepas ≥ hari ini.</p>`}
				`);

				if (!wiz.details) return html + actionRow(null);

				// ── Maklumat trip terpilih ──
				const tgd = wiz.details.trip_group_date;
				html += card(12, '2 · Bilik & Tetamu', `
					<div class="d-flex flex-wrap gap-3 mb-2 text-muted small">
						<span><strong class="text-body">${esc(wiz.details.trip.trip_name)}</strong></span>
						<span>${esc(tgd.departure_date || '')}${tgd.return_date
							? ' → ' + esc(tgd.return_date) : ''}</span>
						${tgd.ship_name ? `<span>🚢 ${esc(tgd.ship_name)}</span>` : ''}
						${tgd.total_nights ? `<span>${tgd.total_nights} malam</span>` : ''}
						<span class="badge badge-light">${isCruise() ? 'Cruise — model slot' : 'Tour — model umur'}</span>
					</div>
					${renderCabinPicker()}
					${wiz.rooms.length ? renderRooms() : ''}
				`, `
					<div class="d-flex flex-wrap gap-2 align-items-center">
						<span class="text-muted small">${wiz.rooms.length
							? wiz.rooms.length + ' bilik dipilih' + (maxCabins() !== Infinity
								? ` (maks ${wiz.ctx.max_cabins}/booking)` : '')
							: 'Belum ada bilik dipilih'}</span>
						<span class="ml-auto font-weight-bold wbz-grand">Jumlah: ${wbzMoney(totals().grand)}</span>
					</div>
				`);
				return html + actionRow(wiz.rooms.length ? 'Next →' : null);
			};

			// Kad pemilih kabin — kategori dengan harga & baki kolam.
			const renderCabinPicker = () => {
				const cabins = wiz.details.cabins || [];
				const rows = cabins.map((c) => {
					const left = c.pool_cabins_left == null ? null : c.pool_cabins_left;
					const blocked = c.available === 0
						|| (left != null && left <= 0)
						|| wiz.rooms.length >= maxCabins()
						|| poolLeft(c.room_category) <= 0;
					const L = wiz.labels[isCruise() ? 'cruise' : 'non_cruise'] || {};
					const p = c.pricing || {};
					const prices = isCruise()
						? [[L.price_adult || 'Main Adult', p.price_adult],
							[L.price_upperberth || 'Extra Bed', p.price_upperberth],
							[L.price_infant || 'Infant', p.price_infant],
							['Single use', p.price_adult_single]]
						: [[L.price_adult || 'Adult', p.price_adult],
							[L.price_children || 'Children', p.price_children],
							[L.price_infant || 'Infant', p.price_infant]];
					return `
						<div class="wbz-cabin ${blocked ? 'wbz-cabin-off' : ''}">
							<div class="d-flex flex-wrap gap-2 align-items-baseline">
								<strong>${esc(c.room_name)}</strong>
								<span class="text-muted small">${esc(c.capacity || 2)} tetamu${c.max_capacity
									&& c.max_capacity !== c.capacity ? ` · maks ${c.max_capacity}` : ''}</span>
								${left != null ? `<span class="badge badge-light">${left} kabin lagi</span>` : ''}
								${c.price_rule ? badge('Promo: ' + (c.price_rule.label || 'promosi'), C.orange) : ''}
								<button class="btn btn-outline-primary btn-sm ml-auto wbz-add-room"
									data-cat="${esc(c.room_category)}" ${blocked ? 'disabled' : ''}>
									+ Bilik</button>
							</div>
							<div class="d-flex flex-wrap gap-3 mt-1 small">
								${prices.map(([lbl, v]) => v ? `
									<span class="text-muted">${esc(lbl)}:
										<strong class="text-body">${fmtNum(v)}</strong></span>` : '').join('')}
							</div>
						</div>`;
				}).join('');
				return `<div class="d-flex flex-column gap-2">${rows}</div>`;
			};

			// Bilik-bilik terpilih + baris tetamu itemized (mirror booknow.js
			// buildGuestRows: Guest 1 dikunci adult + main berth).
			const renderRooms = () => wiz.rooms.map((room, ri) => {
				const cab = cabMap()[room.room_category];
				const caps = slotCaps(room);
				const guestRows = room.guests.map((g, gi) => {
					const rt = rateOf(room, g);
					const locked = gi === 0; // Guest 1 = lead, tak boleh buang
					const catOpts = [];
					if (g.slot !== 'infant') {
						if (isCruise()) {
							// Cruise: kategori bebas (slot mesti sepadan kaunter
							// sahaja — _validate_guest_list); Guest 1 wajib adult.
							if (gi > 0) catOpts.push(['adult', 'Adult'], ['child', 'Child']);
							else catOpts.push(['adult', 'Adult']);
						} else {
							// Non-cruise (model umur): kategori IKAT slot.
							catOpts.push([g.slot === 'extra_bed' ? 'child' : 'adult',
								g.slot === 'extra_bed' ? 'Child' : 'Adult']);
						}
					} else catOpts.push(['infant', 'Infant']);
					const cat = g.category || (g.slot === 'infant' ? 'infant' : 'adult');
					return `
						<div class="wbz-guest-row">
							<span class="wbz-guest-no text-muted">${gi + 1}</span>
							<span class="wbz-guest-slot">${esc(slotLabel(room, g))}${isCruise()
								&& g.slot !== 'main'
								? ` <span class="text-muted small">(${esc(g.slot === 'infant'
									? 'infant' : g.slot === 'extra_bed' ? 'extra bed' : 'main')})</span>`
								: ''}</span>
							<select class="form-control form-control-sm wbz-guest-cat"
								data-ri="${ri}" data-gi="${gi}" ${catOpts.length === 1 ? 'disabled' : ''}>
								${catOpts.map(([v, l]) => `<option value="${v}"
									${v === cat ? 'selected' : ''}>${esc(l)}</option>`).join('')}
							</select>
							<span class="wbz-guest-rate ml-auto">${rt.orig != null && rt.orig !== rt.rate
								? `<span class="wbz-strike small">${fmtNum(rt.orig)}</span> `
								: ''}<strong>${fmtNum(rt.rate)}</strong></span>
							<button class="btn btn-link btn-sm text-danger wbz-rm-guest p-0 pl-2"
								data-ri="${ri}" data-gi="${gi}" ${locked ? 'disabled title="Guest 1 (lead) tidak boleh dibuang"' : ''}>✕</button>
						</div>`;
				}).join('');
				const solo = isCruise() && roomPax(room) === 1;
				const privSel = solo ? `
					<div class="d-flex flex-wrap gap-2 align-items-center mt-2">
						<span class="text-muted small">Privasi bilik:</span>
						<select class="form-control form-control-sm wbz-privacy" data-ri="${ri}"
							style="max-width:220px">
							<option value="Private" ${room.room_privacy !== 'Open Sharing' ? 'selected' : ''}>
								Private — sorangan</option>
							<option value="Open Sharing" ${room.room_privacy === 'Open Sharing' ? 'selected' : ''}>
								Open Sharing — cari roommate</option>
						</select>
					</div>` : '';
				return `
					<div class="wbz-room mt-2">
						<div class="d-flex flex-wrap gap-2 align-items-center">
							<strong>Bilik ${ri + 1} — ${esc(cab?.room_name || room.room_category)}</strong>
							<span class="badge badge-light">${roomPax(room)} tetamu</span>
							<button class="btn btn-outline-danger btn-sm ml-auto wbz-rm-room"
								data-ri="${ri}">Buang Bilik</button>
						</div>
						<div class="wbz-guests mt-1">${guestRows}</div>
						<div class="d-flex flex-wrap gap-2 mt-2">
							<button class="btn btn-default btn-sm wbz-add-guest" data-ri="${ri}"
								data-slot="main" ${caps.main <= 0 ? 'disabled' : ''}>+ Main Berth</button>
							<button class="btn btn-default btn-sm wbz-add-guest" data-ri="${ri}"
								data-slot="extra_bed" ${caps.extra_bed <= 0 ? 'disabled' : ''}>+ Extra Bed</button>
							<button class="btn btn-default btn-sm wbz-add-guest" data-ri="${ri}"
								data-slot="infant" ${caps.infant <= 0 ? 'disabled' : ''}>+ Infant</button>
						</div>
						${privSel}
					</div>`;
			}).join('');

			// ── STEP 2 — Add-on ──────────────────────────────────────────────
			const renderStep2 = () => {
				const groups = wiz.addons?.addons || [];
				const ePax = eligiblePax();
				const groupHtml = groups.length ? groups.map((a) => `
					<div class="wbz-addon-group mt-2">
						<div class="d-flex flex-wrap gap-2 align-items-baseline">
							<strong>${esc(a.addon_title || a.addon)}</strong>
							${a.addon_type ? badge(a.addon_type, C.blue) : ''}
						</div>
						${a.description ? `<div class="text-muted small">${esc(a.description)}</div>` : ''}
						${(a.packages || []).map((p) => {
							const qty = wiz.addonQty[p.addon_package] || 0;
							const maxQty = p.max_qty_per_booking > 0
								? Math.min(p.max_qty_per_booking,
									p.scope && String(p.scope).toLowerCase().includes('pax')
										? Math.max(ePax, 1) : Infinity)
								: (p.scope && String(p.scope).toLowerCase().includes('pax')
									? Math.max(ePax, 1) : Infinity);
							return `
							<div class="wbz-addon-row d-flex flex-wrap gap-2 align-items-center">
								<div>
									<strong>${esc(p.addon_package_name || p.addon_package)}</strong>
									${badge(p.scope || 'Per Booking', C.gray)}
									${p.sold_out ? badge('Habis', C.red) : ''}
									${p.cutoff_closed ? badge('Cutoff tutup', C.orange) : ''}
									${p.remaining != null && !p.sold_out
										? `<span class="text-muted small ml-1">· ${p.remaining} tinggal</span>` : ''}
								</div>
								<span class="ml-auto font-weight-bold">${wbzMoney(p.unit_price)}</span>
								<div class="d-flex align-items-center gap-1">
									<button class="btn btn-default btn-sm wbz-addon-minus"
										data-ap="${esc(p.addon_package)}" ${qty <= 0 || !p.purchasable ? 'disabled' : ''}>−</button>
									<span class="wbz-addon-qty">${qty}</span>
									<button class="btn btn-default btn-sm wbz-addon-plus"
										data-ap="${esc(p.addon_package)}"
										${(!p.purchasable || qty >= maxQty) ? 'disabled' : ''}>+</button>
								</div>
							</div>`;
						}).join('')}
					</div>`).join('')
					: `<p class="text-muted mb-0">Tiada add-on scoped untuk offer ini.</p>`;
				return card(12, '2 · Add-on', `
					<div class="text-muted small mb-1">Add-on di-re-price & di-validate
						semula server-side semasa confirm (stok, cutoff, had qty).
						${ePax ? `Pax layak per-pax: <strong>${ePax}</strong> (main + extra bed).` : ''}</div>
					${groupHtml}
				`) + actionRow('Next →');
			};

			// ── STEP 3 — Pelanggan ───────────────────────────────────────────
			const renderStep3 = () => {
				const b = wiz.billing;
				const addrField = (key, label, cls) => `
					<div class="form-group ${cls || ''}">
						<label class="control-label">${esc(label)}</label>
						<input class="form-control form-control-sm wbz-billing"
							data-key="${key}" value="${esc(b[key] || '')}">
					</div>`;
				return card(12, '3 · Pelanggan', `
					<div class="alert alert-light border small mb-3">
						Booking <strong>on-behalf</strong> — OTP email dilangkau
						(staf: <strong>${esc(wiz.ctx.on_behalf.full_name)}</strong>,
						channel <strong>${esc(wiz.ctx.on_behalf.channel)}</strong>).
						Akaun portal traveller dijana automatik untuk email baharu.
					</div>
					<div class="d-flex flex-wrap gap-2 align-items-end mb-2">
						<div class="form-group flex-grow-1 mb-0" style="max-width:360px">
							<label class="control-label">Email customer</label>
							<input class="form-control form-control-sm wbz-billing" data-key="email"
								type="email" value="${esc(b.email || '')}" placeholder="customer@email.com">
						</div>
						<input class="form-control form-control-sm wbz-lookup-q"
							style="max-width:220px" placeholder="atau cari ikut email/telefon…">
						<button class="btn btn-default btn-sm wbz-lookup">Cari Pelanggan</button>
					</div>
					<div class="form-row">
						<div class="form-group col-md-6">
							<label class="control-label">Nama penuh</label>
							<input class="form-control form-control-sm wbz-billing"
								data-key="full_name" value="${esc(b.full_name || '')}">
						</div>
						<div class="form-group col-md-6">
							<label class="control-label">Telefon</label>
							<input class="form-control form-control-sm wbz-billing"
								data-key="phone" value="${esc(b.phone || '')}" placeholder="+6012-3456789">
						</div>
					</div>
					<div class="text-muted small mb-1">Alamat billing (untuk bil/invois):</div>
					<div class="form-row">
						<div class="form-group col-md-12">${''}
							<label class="control-label">Alamat</label>
							<input class="form-control form-control-sm wbz-billing"
								data-key="address_line1" value="${esc(b.address_line1 || '')}">
						</div>
					</div>
					<div class="form-row">
						${addrField('city', 'Bandar', 'col-md-4')}
						${addrField('postcode', 'Poskod', 'col-md-2')}
						${addrField('state', 'Negeri', 'col-md-2')}
						<div class="form-group col-md-4">
							<label class="control-label">Negara</label>
							<select class="form-control form-control-sm wbz-billing" data-key="country">
								<option value="">— Pilih negara —</option>
								${wiz.countries.map((c) => `<option value="${esc(c.name)}"
									${c.name === b.country ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}
							</select>
						</div>
					</div>
				`) + actionRow('Next →');
			};

			// ── STEP 4 — Bayaran ─────────────────────────────────────────────
			const renderStep4 = () => {
				const t = totals();
				const cur = wiz.offer.currency || '';
				const onlineOk = !!(wiz.pay.online_payment_by_currency
					&& wiz.pay.online_payment_by_currency[cur])
					&& (!wiz.pay.online_payment_min_amount || t.net >= wiz.pay.online_payment_min_amount);
				const manualOk = !!(wiz.pay.bank_accounts
					&& wiz.pay.bank_accounts[cur]);
				const depositBlocked = inFinalWindow() || wTerms().pct <= 0;
				const { pct, fd } = wTerms();
				const due = wiz.payment_method === 'Pay Later' ? 0
					: (wiz.payment_type === 'Full Payment' || depositBlocked
						? t.net : depositOrFull(t.net));
				const cbPct = (wiz.payment_method === 'Manual Transfer'
					&& wiz.pay.cashback_enabled) ? (wiz.pay.cashback_percent || 0) : 0;
				const cbAmt = cbPct > 0 ? round2(due * cbPct / 100) : 0;
				const bank = (wiz.pay.bank_accounts || {})[cur] || {};

				const methodRow = (val, lbl, ok, note) => `
					<label class="d-flex align-items-center gap-2 wbz-pay-method ${ok ? '' : 'text-muted'}">
						<input type="radio" name="wbz-pm" value="${esc(val)}"
							${!ok ? 'disabled' : ''} ${wiz.payment_method === val && ok ? 'checked' : ''}>
						<span><strong>${esc(lbl)}</strong>
							${note ? `<span class="text-muted small"> — ${esc(note)}</span>` : ''}
							${!ok ? '<span class="text-muted small"> (tiada untuk currency ini)</span>' : ''}</span>
					</label>`;

				const bankBlock = wiz.payment_method === 'Manual Transfer' ? `
					<div class="wbz-manual mt-2">
						<div class="text-muted small mb-1">Bank transfer kepada:</div>
						<div class="mb-2 small"><strong>${esc(bank.bank_name || '')}</strong>
							${bank.account_name ? ` — ${esc(bank.account_name)}` : ''}
							${bank.account_number ? ` · <strong>${esc(bank.account_number)}</strong>` : ''}
							${!bank.account_number ? '<span class="text-muted">tiada akaun dikonfigurasi</span>' : ''}</div>
						<div class="form-row">
							<div class="form-group col-md-5">
								<label class="control-label">Rujukan bank customer <span class="text-danger">*</span></label>
								<input class="form-control form-control-sm wbz-bank-ref"
									value="${esc(wiz.bank.ref)}">
							</div>
							<div class="form-group col-md-3">
								<label class="control-label">Tarikh transfer</label>
								<input type="date" class="form-control form-control-sm wbz-bank-date"
									value="${esc(wiz.bank.date)}">
							</div>
							<div class="form-group col-md-4">
								<label class="control-label">Nota</label>
								<input class="form-control form-control-sm wbz-bank-note"
									value="${esc(wiz.bank.note)}">
							</div>
						</div>
						<div class="form-group">
							<label class="control-label">Resit pembayaran <span class="text-danger">*</span></label>
							<input type="file" class="wbz-receipt" accept="image/*,.pdf">
							${wiz.receipt ? '<span class="text-success small ml-2">✓ resit dilampir</span>'
								: '<span class="text-muted small ml-2">JPG/PNG/PDF ≤ 2MB</span>'}
						</div>
					</div>` : '';

				const spRows = wiz.salesPersons.map((sp) => `
					<label class="d-flex align-items-center gap-2 mr-3 mb-1">
						<input type="checkbox" class="wbz-sp" value="${esc(sp.name)}"
							${wiz.sales_persons.includes(sp.name) ? 'checked' : ''}>
						<span>${esc(sp.sales_person_name || sp.name)}</span>
					</label>`).join('');

				return card(12, '4 · Bayaran', `
					<div class="wbz-totals mb-3">
						${t.retail != null ? `<div class="wbz-totrow text-muted">
							<span>Harga asal</span>
							<span class="wbz-strike">${wbzMoney(t.retail)}</span></div>` : ''}
						<div class="wbz-totrow"><span>Jumlah (harga promo)</span>
							<span>${wbzMoney(t.grand)}</span></div>
						${t.v > 0 ? `<div class="wbz-totrow text-success">
							<span>Voucher ${esc(wiz.voucher.applied)}</span>
							<span>−${wbzMoney(t.v)}</span></div>` : ''}
						${t.ref > 0 ? `<div class="wbz-totrow text-success">
							<span>Referral ${esc(wiz.affiliate.applied)} (${t.refPct}%)</span>
							<span>−${wbzMoney(t.ref)}</span></div>` : ''}
						<div class="wbz-totrow wbz-net"><span><strong>Jumlah bayaran</strong></span>
							<span><strong>${wbzMoney(t.net)}</strong></span></div>
						${wiz.payment_method !== 'Pay Later' ? `
						<div class="wbz-totrow mt-1"><span>Bayaran kini
							(${depositBlocked ? 'penuh — dalam tetingkap bayaran akhir'
								: wiz.payment_type === 'Full Payment' ? 'penuh'
								: `deposit ${pct}%`})</span>
							<span>${wbzMoney(due)}</span></div>
						${cbAmt > 0 ? `<div class="wbz-totrow text-success">
							<span>Cashback manual transfer (${cbPct}%)</span>
							<span>−${wbzMoney(cbAmt)}</span></div>
						<div class="wbz-totrow"><span><strong>Tunai diterima</strong></span>
							<span><strong>${wbzMoney(round2(due - cbAmt))}</strong></span></div>` : ''}
						` : ''}
						${pct > 0 && !depositBlocked ? `<div class="text-muted small">
							Baki: ${wbzMoney(round2(t.net - due))} — tempoh
							${fd || wiz.ctx.default_final_payment_days} hari sebelum berlepas.</div>` : ''}
					</div>

					<div class="wbz-pay-methods">
						${methodRow('Online Payment', 'Online Payment', onlineOk,
							'jana pautan Stripe')}
						${methodRow('Manual Transfer', 'Manual Transfer', manualOk,
							'rekod resit + rujukan bank')}
						${methodRow('Pay Later', 'Pay Later (Held Booking)', true,
							'tahan tempahan, bayar kemudian')}
					</div>
					${wiz.payment_method !== 'Pay Later' ? `
					<div class="d-flex flex-wrap gap-3 mt-2 wbz-ptypes">
						<label class="d-flex align-items-center gap-2 ${depositBlocked ? 'text-muted' : ''}">
							<input type="radio" name="wbz-pt" value="Deposit" class="wbz-ptype"
								${depositBlocked ? 'disabled' : ''}
								${wiz.payment_type === 'Deposit' && !depositBlocked ? 'checked' : ''}>
							<span>Deposit ${pct}% — ${wbzMoney(round2(t.net * pct / 100))}</span>
						</label>
						<label class="d-flex align-items-center gap-2">
							<input type="radio" name="wbz-pt" value="Full Payment" class="wbz-ptype"
								${wiz.payment_type === 'Full Payment' || depositBlocked ? 'checked' : ''}>
							<span>Bayaran Penuh — ${wbzMoney(t.net)}</span>
						</label>
					</div>
					${depositBlocked ? `<div class="text-muted small mt-1">Deposit tidak tersedia —
						dalam tetingkap bayaran akhir (departure − ${fd} hari) atau deposit 0%.</div>` : ''}
					` : ''}
					${onlineOk ? '' : `<div class="text-muted small mt-1">
						${!wiz.pay.online_payment_by_currency?.[cur]
							? 'Payment gateway tidak dikonfigurasi untuk ' + esc(cur) + '.'
							: `Online memerlukan minimum ${wbzMoney(wiz.pay.online_payment_min_amount)}.`}</div>`}
					${bankBlock}

					<div class="form-row mt-3">
						<div class="form-group col-md-6">
							<label class="control-label">Voucher code</label>
							<div class="d-flex gap-2">
								<input class="form-control form-control-sm wbz-voucher-in"
									value="${esc(wiz.voucher.code)}" ${wiz.voucher.applied ? 'disabled' : ''}
									placeholder="Kod voucher">
								<button class="btn btn-default btn-sm wbz-voucher-apply"
									${wiz.voucher.applied ? 'disabled' : ''}>${wiz.voucher.applied ? '✓' : 'Apply'}</button>
								${wiz.voucher.applied ? `<button class="btn btn-link btn-sm text-danger wbz-voucher-rm">buang</button>` : ''}
							</div>
							${voucherMsg()}
						</div>
						<div class="form-group col-md-6">
							<label class="control-label">Kod referral</label>
							<div class="d-flex gap-2">
								<input class="form-control form-control-sm wbz-aff-in"
									value="${esc(wiz.affiliate.code)}" ${wiz.affiliate.applied ? 'disabled' : ''}
									placeholder="Kod referral">
								<button class="btn btn-default btn-sm wbz-aff-apply"
									${wiz.affiliate.applied ? 'disabled' : ''}>${wiz.affiliate.applied ? '✓' : 'Apply'}</button>
								${wiz.affiliate.applied ? `<button class="btn btn-link btn-sm text-danger wbz-aff-rm">buang</button>` : ''}
							</div>
							${affMsg()}
						</div>
					</div>
					${spRows ? `<div class="form-group">
						<label class="control-label">Sales persons (opsyenal)</label>
						<div class="d-flex flex-wrap">${spRows}</div></div>` : ''}
					<div class="form-group">
						<label class="control-label">Mesej / nota (opsyenal)</label>
						<textarea class="form-control form-control-sm wbz-msg" rows="2"
							maxlength="2000">${esc(wiz.customer_message)}</textarea>
					</div>
					${wiz.ctx.terms ? `
					<div class="wbz-terms mt-2">
						<label class="d-flex align-items-start gap-2 mb-1">
							<input type="checkbox" class="wbz-terms-ok" ${wiz.terms_ok ? 'checked' : ''}>
							<span>Customer telah baca & bersetuju dengan
								<strong>${esc(wiz.ctx.terms.title)}</strong>
								<button class="btn btn-link btn-sm wbz-terms-view p-0 pl-1">(papar)</button></span>
						</label>
						<div class="wbz-terms-body d-none small border rounded p-2">${wiz.ctx.terms.content || ''}</div>
					</div>` : ''}
				`) + actionRow(wiz.busy ? 'Mencipta booking…' : 'Cipta Booking');
			};

			const voucherMsg = () => {
				const c = wiz.voucher.checked;
				if (!c) return '';
				return `<div class="small ${c.valid ? 'text-success' : 'text-danger'} mt-1">
					${esc(c.message || '')}</div>`;
			};
			const affMsg = () => {
				const c = wiz.affiliate.checked;
				if (!c) return '';
				return `<div class="small ${c.valid ? 'text-success' : 'text-danger'} mt-1">
					${esc(c.message || '')}</div>`;
			};

			// ── STEP 5 — Skrin keputusan (selepas submit berjaya) ────────────
			const renderResult = () => {
				const r = wiz.result;
				$body.html(`
					<div class="wbz-wrap">
						<div class="d-flex flex-wrap gap-2 align-items-center mb-3 text-success">${stepDots()}</div>
						${card(12, '✓ Booking Dicipta', `
							<div class="d-flex flex-wrap gap-2 align-items-baseline mb-3">
								<h4 class="mb-0 font-weight-bold">${esc(r.booking_number)}</h4>
								${badge(r.booking_status || 'Pending', C.orange)}
								${badge(r.payment_status || 'Pending', C.orange)}
								<span class="text-muted small ml-auto">SO: ${esc(r.sales_order || '')}</span>
							</div>
							<div class="form-row">
								${field('Jumlah (promo)', wbzMoney(r.grand_total), 'col-md-3 col-6')}
								${(r.voucher_discount || r.referral_discount) ? field('Diskaun', wbzMoney(
									round2((r.voucher_discount || 0) + (r.referral_discount || 0))), 'col-md-3 col-6') : ''}
								${field('Bayaran kini', wbzMoney(r.amount_due || 0), 'col-md-3 col-6')}
								${field('Kaedah', esc(r.payment_method || ''), 'col-md-3 col-6')}
							</div>
							${r.payment_url ? `
							<div class="d-flex flex-wrap gap-2 mt-2">
								<a class="btn btn-primary btn-sm" href="${esc(r.payment_url)}"
									target="_blank" rel="noopener">Buka Halaman Bayaran ↗</a>
								<button class="btn btn-default btn-sm wbz-copy-link">Salin Pautan Bayaran</button>
							</div>
							<div class="text-muted small mt-1">Pautan Stripe untuk customer —
								boleh dihantar melalui WhatsApp/emel.</div>` : ''}
							${r.cashback_amount > 0 ? `<div class="text-success small mt-2">
								Cashback manual transfer: ${wbzMoney(r.cashback_amount)}</div>` : ''}
							${r.addons_created ? `<div class="small mt-2">Add-on order:
								<strong>${esc(r.addon_order || '')}</strong>
								(${wbzMoney(r.addon_total || 0)})</div>` : ''}
							${r.addons_error ? `<div class="alert alert-warning mt-2 mb-0 small">
								<strong>Add-on gagal dicipta</strong> (booking utama kekal sah):<br>
								${esc(r.addons_error)}</div>` : ''}
							${r.payment_setup_failed ? `<div class="alert alert-warning mt-2 mb-0 small">
								Payment setup gagal: ${esc(r.payment_error || '')} —
								guna Pay Later / manual payment link kemudian.</div>` : ''}
							<div class="d-flex flex-wrap gap-2 mt-3">
								<button class="btn btn-primary btn-sm wbz-open-booking"
									data-bkg="${esc(r.booking)}">Buka Booking →</button>
								<button class="btn btn-default btn-sm wbz-again">Tempah Lagi</button>
							</div>
						`)}`);
				wireResult();
			};

			// ── WIRE (handlers dibind semula selepas setiap render) ──────────
			const wire = () => {
				const $b = $body;

				// Step 1 — pemilih offer
				$b.find('.wbz-trip-sel').on('change', async function () {
					wiz.trip = $(this).val();
					await reloadOffers();
				});
				$b.find('.wbz-offer-q').on('input', frappe.utils.debounce(async function () {
					wiz.q = $(this).val();
					await reloadOffers();
				}, 350));
				$b.find('.wbz-pick-offer').on('click', async function () {
					const name = $(this).data('offer');
					const o = wiz.offers.find((x) => x.name === name);
					if (!o) return;
					wiz.offer = o; wiz.rooms = []; wiz.details = null;
					wiz.addonQty = {}; wiz.addons = null;
					wiz.voucher = { code: '', checked: null, applied: '' };
					wiz.affiliate = { code: '', checked: null, applied: '' };
					render();
					try {
						wiz.details = await pbk('travel_booking.api.pricing.get_booking_details',
							{ trip_group_date: '', trip_package: '', package_offer: name });
					} catch (e) { wiz.details = null; }
					render();
				});
				$b.find('.wbz-add-room').on('click', function () {
					if (wiz.rooms.length >= maxCabins()) {
						frappe.show_alert({ message: `Maksimum ${wiz.ctx.max_cabins} bilik/booking`,
							indicator: 'red' }); return;
					}
					const cat = String($(this).data('cat'));
					if (poolLeft(cat) <= 0) {
						frappe.show_alert({ message: 'Kabin kategori ini telah penuh (kolam sailing)',
							indicator: 'red' }); return;
					}
					// Bilik baru bermula 1 lead guest — adult + main berth.
					wiz.rooms.push({ room_category: cat,
						guests: [{ slot: 'main', category: 'adult' }], room_privacy: '' });
					render();
				});
				$b.find('.wbz-rm-room').on('click', function () {
					wiz.rooms.splice(parseInt($(this).data('ri'), 10), 1);
					render();
				});
				$b.find('.wbz-add-guest').on('click', function () {
					const ri = parseInt($(this).data('ri'), 10);
					const slot = String($(this).data('slot'));
					const room = wiz.rooms[ri];
					if (!room) return;
					const caps = slotCaps(room);
					if ((slot === 'infant' ? caps.infant : caps[slot]) <= 0) return;
					room.guests.push({ slot, category: slot === 'infant' ? 'infant' : 'adult' });
					render();
				});
				$b.find('.wbz-rm-guest').on('click', function () {
					const ri = parseInt($(this).data('ri'), 10);
					const gi = parseInt($(this).data('gi'), 10);
					const room = wiz.rooms[ri];
					if (!room || gi === 0) return;
					room.guests.splice(gi, 1);
					// Cascade mirror applyRoomCascades: buang extra bed bila
					// main tak lagi penuh (cruise); buang infant bila tiada main.
					const cap = cabMap()[room.room_category]?.capacity || 0;
					if (isCruise() && gCount(room, 'main') !== cap)
						room.guests = room.guests.filter((g) => g.slot !== 'extra_bed');
					if (gCount(room, 'main') < 1)
						room.guests = room.guests.filter((g) => g.slot !== 'infant');
					render();
				});
				$b.find('.wbz-guest-cat').on('change', function () {
					const ri = $(this).data('ri'), gi = $(this).data('gi');
					const room = wiz.rooms[ri];
					if (room && room.guests[gi]) {
						room.guests[gi].category = $(this).val();
						render();
					}
				});
				$b.find('.wbz-privacy').on('change', function () {
					const ri = parseInt($(this).data('ri'), 10);
					if (wiz.rooms[ri]) wiz.rooms[ri].room_privacy = $(this).val();
				});

				// Step 2 — add-on qty
				$b.find('.wbz-addon-plus').on('click', function () {
					const ap = String($(this).data('ap'));
					wiz.addonQty[ap] = (wiz.addonQty[ap] || 0) + 1;
					render();
				});
				$b.find('.wbz-addon-minus').on('click', function () {
					const ap = String($(this).data('ap'));
					wiz.addonQty[ap] = Math.max(0, (wiz.addonQty[ap] || 0) - 1);
					render();
				});

				// Step 3 — billing + lookup
				$b.find('.wbz-billing').on('change input', function () {
					const key = String($(this).data('key'));
					if (!key) return;
					let val = $(this).val();
					if (key === 'full_name') val = String(val).toUpperCase();
					if (key === 'email') val = String(val).trim().toLowerCase();
					wiz.billing[key] = val;
				});
				$b.find('.wbz-lookup').on('click', () => doLookup());
				$b.find('.wbz-lookup-q').on('keydown', (e) => {
					if (e.key === 'Enter') { e.preventDefault(); doLookup(); }
				});

				// Step 4 — bayaran
				$b.find('input[name="wbz-pm"]').on('change', function () {
					if (this.checked) { wiz.payment_method = $(this).val(); render(); }
				});
				$b.find('.wbz-ptype').on('change', function () {
					if (this.checked) { wiz.payment_type = $(this).val(); render(); }
				});
				$b.find('.wbz-bank-ref').on('change input', function () { wiz.bank.ref = $(this).val().trim(); });
				$b.find('.wbz-bank-date').on('change', function () { wiz.bank.date = $(this).val(); });
				$b.find('.wbz-bank-note').on('change input', function () { wiz.bank.note = $(this).val().trim(); });
				$b.find('.wbz-receipt').on('change', function () {
					const f = this.files && this.files[0];
					if (!f) { wiz.receipt = null; return; }
					if (f.size > 2 * 1024 * 1024) {
						frappe.show_alert({ message: 'Resit melebihi 2MB — mampatkan dahulu',
							indicator: 'red' });
						this.value = ''; wiz.receipt = null; return;
					}
					const fr = new FileReader();
					fr.onload = () => { wiz.receipt = String(fr.result || ''); render(); };
					fr.readAsDataURL(f);
				});
				$b.find('.wbz-voucher-apply').on('click', () => applyVoucher());
				$b.find('.wbz-voucher-in').on('keydown', (e) => {
					if (e.key === 'Enter') { e.preventDefault(); applyVoucher(); }
				});
				$b.find('.wbz-voucher-rm').on('click', () => {
					wiz.voucher = { code: '', checked: null, applied: '' }; render();
				});
				$b.find('.wbz-aff-apply').on('click', () => applyAffiliate());
				$b.find('.wbz-aff-in').on('keydown', (e) => {
					if (e.key === 'Enter') { e.preventDefault(); applyAffiliate(); }
				});
				$b.find('.wbz-aff-rm').on('click', () => {
					wiz.affiliate = { code: '', checked: null, applied: '' }; render();
				});
				$b.find('.wbz-sp').on('change', function () {
					const name = $(this).val();
					wiz.sales_persons = this.checked
						? [...new Set([...wiz.sales_persons, name])]
						: wiz.sales_persons.filter((n) => n !== name);
				});
				$b.find('.wbz-msg').on('change input', function () {
					wiz.customer_message = $(this).val().trim();
				});
				$b.find('.wbz-terms-ok').on('change', function () { wiz.terms_ok = !!this.checked; });
				$b.find('.wbz-terms-view').on('click', () => {
					$body.find('.wbz-terms-body').toggleClass('d-none');
				});

				// Navigasi aksi
				$b.find('.wbz-cancel').on('click', () => {
					frappe.confirm('Buang pendaftaran booking ini?', () =>
						frappe.set_route('travel-manager', 'booking-group'));
				});
				$b.find('.wbz-back').on('click', () => {
					if (wiz.busy) return;
					wiz.step = Math.max(1, wiz.step - 1);
					render();
				});
				$b.find('.wbz-next').on('click', () => next());
			};

			const wireResult = () => {
				$body.find('.wbz-open-booking').on('click', function () {
					frappe.set_route('travel-manager', 'booking-group', String($(this).data('bkg')));
				});
				$body.find('.wbz-again').on('click', () => {
					frappe.set_route('travel-manager', 'booking-group', 'new');
				});
				$body.find('.wbz-copy-link').on('click', () => {
					const url = wiz.result?.payment_url || '';
					if (!url) return;
					navigator.clipboard?.writeText(url).then(() =>
						frappe.show_alert({ message: 'Pautan bayaran disalin', indicator: 'green' }));
				});
			};

			// ── AKSI ──────────────────────────────────────────────────────────
			const reloadOffers = async () => {
				const res = await dbk('list_sellable_offers',
					{ trip: wiz.trip || '', q: wiz.q || '', limit: 200 });
				wiz.offers = res?.offers || [];
				render();
			};

			const doLookup = async () => {
				const q = $body.find('.wbz-lookup-q').val()
					|| $body.find('.wbz-billing[data-key="email"]').val() || '';
				if (!q.trim()) return;
				const res = await dbk('lookup_customer', { query: q.trim() });
				if (res?.found) {
					wiz.billing.email = res.email || wiz.billing.email;
					wiz.billing.full_name = (res.customer_name || '').toUpperCase();
					wiz.billing.phone = res.phone || wiz.billing.phone;
					Object.assign(wiz.billing, res.address || {});
					frappe.show_alert({ message: 'Pelanggan dijumpai — borang diautofill',
						indicator: 'green' });
					render();
				} else {
					frappe.show_alert({ message: 'Tiada pelanggan dijumpai — isi borang baharu',
						indicator: 'orange' });
				}
			};

			const applyVoucher = async () => {
				const code = ($body.find('.wbz-voucher-in').val() || '').trim().toUpperCase();
				if (!code) return;
				wiz.voucher.code = code;
				const t = totals();
				const sels = buildSelections().map((s) => ({
					room_category: s.room_category, main_guests: s.main_guests,
					extra_beds: s.extra_beds, infants: s.infants }));
				const res = await pbk('travel_booking.api.booking.validate_voucher', {
					code,
					trip_group_date: wiz.offer.legacy_tgd || '',
					grand_total: t.grand,
					email: wiz.billing.email || '',
					selections: JSON.stringify(sels),
					// Nama warisan untuk scope-match — parity portal offer-mode.
					trip_package: wiz.offer.legacy_trip_package || '',
					is_cruise: isCruise(),
				});
				wiz.voucher.checked = res || { valid: false, message: 'Sila Cuba Lagi' };
				wiz.voucher.applied = res?.valid ? code : '';
				render();
			};

			const applyAffiliate = async () => {
				const code = ($body.find('.wbz-aff-in').val() || '').trim().toUpperCase();
				if (!code) return;
				wiz.affiliate.code = code;
				const res = await pbk('travel_booking.api.booking.validate_affiliate_code', {
					code,
					trip_group_date: wiz.offer.legacy_tgd || '',
				});
				wiz.affiliate.checked = res || { valid: false, message: 'Sila Cuba Lagi' };
				wiz.affiliate.applied = res?.valid ? code : '';
				render();
			};

			// Payload selections — mirror booknow.js: per-bilik, itemisasi
			// guests[] (slot+category), kaunter derived daripada baris; privasi
			// hanya kabin cruise solo (kosong = Private di server).
			const buildSelections = () => wiz.rooms.map((room) => ({
				room_category: room.room_category,
				main_guests: gCount(room, 'main'),
				extra_beds: gCount(room, 'extra_bed'),
				infants: gCount(room, 'infant'),
				guests: room.guests.map((g) => ({
					slot: g.slot || 'main',
					category: g.category || (g.slot === 'infant' ? 'infant' : 'adult'),
				})),
				room_privacy: (isCruise() && roomPax(room) === 1)
					? (room.room_privacy === 'Open Sharing' ? 'Open Sharing' : 'Private')
					: '',
			}));

			const addonLines = () => Object.entries(wiz.addonQty || {})
				.filter(([, q]) => q > 0).map(([ap, q]) => ({ addon_package: ap, qty: q }));

			const readBilling = () => {
				// Baca semula input billing dari DOM (state mungkin lag di belakang
				// bila user taip tanpa 'change') — corak readXxxInputs wizard trip.
				$body.find('.wbz-billing').each(function () {
					const key = String($(this).data('key') || '');
					if (!key) return;
					let v = $(this).val() || '';
					if (key === 'full_name') v = v.toUpperCase();
					if (key === 'email') v = v.trim().toLowerCase();
					wiz.billing[key] = v;
				});
				return {
					email: wiz.billing.email.trim().toLowerCase(),
					full_name: wiz.billing.full_name.trim().toUpperCase(),
					phone: wiz.billing.phone.trim(),
					address_line1: wiz.billing.address_line1.trim(),
					city: wiz.billing.city.trim(),
					postcode: wiz.billing.postcode.trim(),
					state: wiz.billing.state.trim(),
					country: wiz.billing.country.trim(),
				};
			};

			const validateStep = () => {
				if (wiz.step === 1) {
					if (!wiz.details) return 'Pilih Trip & Package Offer dahulu.';
					if (!wiz.rooms.length) return 'Pilih sekurang-kurangnya SATU bilik.';
					const bad = wiz.rooms.find((r) => gCount(r, 'main') < 1);
					if (bad) return 'Setiap bilik mesti ada sekurang-kurangnya 1 Main Guest.';
				}
				if (wiz.step === 3) {
					const b = readBilling();
					if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(b.email))
						return 'Email customer tidak sah.';
					if (!b.full_name) return 'Nama penuh customer wajib diisi.';
					if (b.phone.replace(/\D/g, '').length < 7)
						return 'Telefon customer tidak sah (min. 7 digit).';
					const missing = ['address_line1', 'city', 'postcode', 'state', 'country']
						.filter((k) => !b[k]);
					if (missing.length)
						return 'Alamat billing tidak lengkap: ' + missing.join(', ');
				}
				if (wiz.step === 4) {
					const t = totals();
					if (wiz.payment_method === 'Manual Transfer') {
						if (!($body.find('.wbz-bank-ref').val() || '').trim())
							return 'Rujukan bank transfer wajib diisi.';
						if (!wiz.receipt) return 'Lampirkan resit pembayaran.';
					}
					if (wiz.payment_method === 'Online Payment'
						&& wiz.pay.online_payment_min_amount
						&& t.net < wiz.pay.online_payment_min_amount)
						return 'Online memerlukan minimum '
							+ wbzMoney(wiz.pay.online_payment_min_amount) + '.';
					if (wiz.ctx.terms && !wiz.terms_ok)
						return 'Tandakan persetujuan Terms & Conditions dahulu.';
				}
				return null;
			};

			const next = async () => {
				if (wiz.busy) return;
				const err = validateStep();
				if (err) { frappe.show_alert({ message: err, indicator: 'red' }); return; }

				if (wiz.step === 1) {
					// Muat katalog add-on (panduan harga) sebelum masuk step 2.
					wiz.step = 2; render();
					if (!wiz.addons) {
						const res = await pbk(
							'travel_booking.api.addon_manager.get_wizard_addons', {
								package_offer: wiz.offer.name,
								currency: wiz.offer.currency,
							});
						wiz.addons = res || { addons: [] };
						render();
					}
					return;
				}
				if (wiz.step < 4) { wiz.step += 1; render(); return; }

				// Step 4 → SUBMIT (satu-satunya titik penciptaan rekod).
				wiz.busy = true; render();
				try {
					const t = totals();
					const payment_type = wiz.payment_method === 'Pay Later'
						? 'Deposit' // mirror portal — nilai tak mengubah kelakuan
						: (inFinalWindow() || wiz.payment_type === 'Full Payment'
							? 'Full Payment' : 'Deposit');
					const res = await dbk('create_desk_booking', {
						package_offer: wiz.offer.name,
						selections: JSON.stringify(buildSelections()),
						billing: JSON.stringify(readBilling()),
						payment_type,
						payment_method: wiz.payment_method,
						receipt: wiz.receipt || '',
						voucher_code: wiz.voucher.applied || '',
						affiliate_code: wiz.affiliate.applied || '',
						sales_persons: JSON.stringify(wiz.sales_persons),
						bank_transfer_ref: wiz.bank.ref,
						bank_transfer_date: wiz.bank.date,
						bank_transfer_note: wiz.bank.note,
						terms_accepted: !!wiz.terms_ok,
						terms_reference: wiz.ctx.terms?.name || '',
						customer_message: wiz.customer_message,
						addons: JSON.stringify(addonLines()),
					});
					if (!res || !res.success)
						throw new Error(res?.message || 'Booking gagal dicipta.');
					wiz.result = res;
					frappe.show_alert({ message: 'Booking ' + res.booking_number
						+ ' dicipta', indicator: 'green' });
				} catch (e) {
					frappe.msgprint({ title: 'Booking Gagal',
						message: e.message || frappe.get_error_message?.() || String(e),
						indicator: 'red' });
				}
				wiz.busy = false;
				render();
			};

			// ── BOOTSTRAP ─────────────────────────────────────────────────────
			breadcrumb([
				{ label: 'Travel Manager', route: ['travel-manager'] },
				{ label: 'Booking', route: ['travel-manager', 'booking'] },
				{ label: 'Booking Group', route: ['travel-manager', 'booking-group'] },
				{ label: 'Booking Baru' },
			]);
			$body.html(loading());

			// Bootstrap selari portal booknow.py: konteks desk + terma bayaran +
			// sales persons + label slot harga (cruise & non-cruise).
			Promise.all([
				dbk('get_wizard_context'),
				pbk('travel_booking.api.pricing.get_payment_settings'),
				pbk('travel_booking.api.pricing.get_sales_persons'),
				pbk('travel_booking.api.price_config.fetch_price_labels',
					{ trip_type: 'cruise' }),
				pbk('travel_booking.api.price_config.fetch_price_labels',
					{ trip_type: 'non-cruise' }),
				frappe.db.get_list('Country', { fields: ['name'],
					order_by: 'name asc', limit: 500 }).catch(() => []),
			]).then(([ctx, pay, sp, lblCruise, lblNon, countries]) => {
				wiz.ctx = ctx || { use_package_offers: false, max_cabins: 8,
					on_behalf: { ok: false, channel: '', full_name: '' },
					default_deposit_percent: 0, default_final_payment_days: 0,
					terms: null };
				wiz.pay = pay || { bank_accounts: {}, online_payment_by_currency: {},
					online_payment_min_amount: 0, cashback_enabled: 0,
					cashback_percent: 0, default_deposit_percent: 20 };
				wiz.salesPersons = sp || [];
				const toMap = (rows) => Object.fromEntries((rows || [])
					.map((r) => [r.price_key, r.display_label]));
				wiz.labels = { cruise: toMap(lblCruise), non_cruise: toMap(lblNon) };
				wiz.countries = countries || [];
				render();
				reloadOffers();
			});
		}
