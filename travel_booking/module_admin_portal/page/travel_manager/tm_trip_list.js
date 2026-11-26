	/* ════════════════════════════════════════════════════════════════════
	   SEKSYEN: TRIP LIST — L1 (tm_trip_list.js)
	   ════════════════════════════════════════════════════════════════════
	   Senarai trip + ringkasan readiness + carian + kad jadual/telefon
	   dan pintu masuk wizard "New Trip".
	   Di-include ke dalam scope IIFE page oleh render_include
	   (concatenation server-side) — semua fungsi/const di sini HIDUP
	   dalam scope page travel_manager dan boleh merujuk closure shell
	   ($body, $bc, wrapper, state, breadcrumb, dsb.) secara terus.
	   API AWAM: load_trips() (dipanggil oleh router shell).
	   ════════════════════════════════════════════════════════════════════ */

		// ════════════ TRIP (list) ════════════
		async function load_trips() {
			breadcrumb([
				{ label: 'Travel Manager', route: ['travel-manager'] },
				{ label: 'Trip' },
			]);
			$body.html(loading());

			const [tripsData, ready] = await Promise.all([
				tcc('get_trips_list', { search: state.search, limit: 60 }),
				tcc('get_readiness_summary', {}),
			]);
			const trips = tripsData?.trips || [];
			const s = ready?.summary || { ready: 0, warning: 0, error: 0 };

			// Table (≥992px) and cards (phone) — both rendered; CSS picks by
			// screen width (manage-booking-app convention).
			const rowsHtml = trips.map((t) => `
				<tr class="tm-trip" data-trip="${esc(t.name)}">
					<td>
						<div class="font-weight-bold">${esc(t.trip_name)}</div>
						<div class="text-muted text-small">${esc(t.name)}</div>
					</td>
					<td>${t.is_a_cruise_trip ? badge('🚢 Cruise', C.blue) : badge('✈️ Tour', C.orange)}</td>
					<td>${badge(t.status || 'Active', DEP_COLOR[t.status] || C.gray)}</td>
					<td class="text-center"><strong>${t.dates_count || 0}</strong></td>
					<td>${t.min_price != null ? esc(fmtNum(t.min_price)) : '<span class="text-extra-muted">—</span>'}</td>
					<td class="text-muted">${esc((t.route || '-').slice(0, 30))}</td>
					<td>${badge(t.published ? '🌐 Web' : '📝 Draft', t.published ? C.green : C.gray)}</td>
				</tr>
			`).join('');

			const cardsHtml = trips.map((t) => `
				<div class="card pointer tm-trip" data-trip="${esc(t.name)}">
					<div class="card-body py-3">
						<div class="d-flex align-items-start gap-2">
							<div class="flex-fill min-w-0">
								<div class="font-weight-bold break-words">${esc(t.trip_name)}</div>
								<div class="text-muted text-small break-words mt-1">${esc(t.name)} · ${esc((t.route || '-').slice(0, 30))}</div>
							</div>
							${badge(t.status || 'Active', DEP_COLOR[t.status] || C.gray)}
						</div>
						<div class="d-flex flex-wrap gap-2 mt-2">
							${t.is_a_cruise_trip ? badge('🚢 Cruise', C.blue) : badge('✈️ Tour', C.orange)}
							${badge(t.published ? '🌐 Web' : '📝 Draft', t.published ? C.green : C.gray)}
						</div>
						<div class="d-flex align-items-center flex-wrap gap-2 border-top mt-2 pt-2 text-muted text-small">
							<span>📅 <b class="text-body">${t.dates_count || 0}</b> dates</span>
							<span class="ml-auto">${t.min_price != null
								? `💰 from <b class="text-body">${esc(fmtNum(t.min_price))}</b>` : ''}</span>
						</div>
					</div>
				</div>
			`).join('');

			$body.html(`
				<div class="d-flex flex-wrap gap-2 align-items-center text-muted mb-3">
					<div class="d-flex gap-2 overflow-auto py-1" aria-label="Trip readiness">
						<span class="text-nowrap" style="color:${C.green}"><strong>${s.ready || 0}</strong> ready</span>
						<span class="text-nowrap" style="color:${C.orange}"><strong>${s.warning || 0}</strong> warnings</span>
						<span class="text-nowrap" style="color:${C.red}"><strong>${s.error || 0}</strong> need action</span>
					</div>
					<div class="d-flex gap-2 ml-auto">
						<input class="form-control form-control-sm w-auto tm-search" placeholder="Search trips…"
							value="${esc(state.search)}" aria-label="Search trips">
						<button type="button" class="btn btn-primary btn-sm tm-new-trip">+ New Trip</button>
					</div>
				</div>
				${card(12, `🧭 TRIPS (${trips.length})`, `
				<div class="d-flex flex-column gap-2 d-lg-none">${cardsHtml || ''}</div>
				<div class="d-none d-lg-block">
					${tmTable(
						['Trip', 'Type', 'Status', 'Dates', 'Price from', 'Route', 'Web'],
						rowsHtml,
						'No trips yet. Click "+ New Trip" to create one.',
					)}
				</div>
				${trips.length ? '' : `<p class="text-muted small d-lg-none mt-2">
					No trips yet. Click "+ New Trip" to create one.</p>`}`)}
			`);

			$body.find('.tm-new-trip').on('click', () =>
				frappe.set_route('travel-manager', 'trip', 'new-trip'));
			$body.find('.tm-trip').on('click', function () {
				frappe.set_route('travel-manager', 'trip', $(this).data('trip'));
			});
			$body.find('.tm-search').on('input', frappe.utils.debounce(function () {
				state.search = $(this).val(); load_trips();
			}, 400));
		}
