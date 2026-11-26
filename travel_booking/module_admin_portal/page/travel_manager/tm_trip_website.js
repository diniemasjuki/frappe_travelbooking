	/* ════════════════════════════════════════════════════════════════════
	   SEKSYEN: TRIP WEBSITE — CMS kandungan (tm_trip_website.js)
	   ════════════════════════════════════════════════════════════════════
	   Urus tab Website doctype Trip TANPA borang Trip: Content,
	   Gallery, Itinerary template, Highlights, Features, FAQ, SEO.
	   Di-include ke dalam scope IIFE page oleh render_include
	   (concatenation server-side) — semua fungsi/const di sini HIDUP
	   dalam scope page travel_manager dan boleh merujuk closure shell
	   ($body, $bc, wrapper, state, breadcrumb, dsb.) secara terus.
	   API AWAM: load_trip_website() (router).
	   ════════════════════════════════════════════════════════════════════ */

		// ════════════ TRIP WEBSITE (manage kandungan — Nov 2026) ════════════
		// Urus tab Website doctype Trip TANPA akses borang Trip: Content
		// (title/route/published/video/description/cover) · Gallery (rekod
		// File dilampir pada Trip) · Itinerary · Highlights · Features ·
		// FAQ · Facilities · SEO (meta + featured + itinerary caption).
			// State `web` satu sumber kebenaran; render() bina semula kad
			// (semua kad COLLAPSIBLE — klik header buka/tutup, TUTUP
			// secara lalai). Save PER-KAD di BAWAH card-body setiap kad —
			// payload separa (save_trip_website hanya tulis medan/jadual
			// yang hadir dalam payload); input biasa dibaca dari DOM semasa
			// Save (data-f / data-i+data-c).

		// Status buka kad website per trip — { [trip]: { key: true } } —
		// aras IIFE supaya kekal merentas re-render & reload halaman
		// (cth. selepas upload/buang imej galeri yang load_trip_website
		// semula). Default: SEMUA kad TUTUP — hanya kad yang pengguna
		// buka sendiri dirender terbuka semula.
		const wsOpen = {};

			async function load_trip_website(trip) {
			breadcrumb([
				{ label: 'Travel Manager', route: ['travel-manager'] },
				{ label: 'Trip', route: ['travel-manager', 'trip'] },
				{ label: trip },
			]);
			$body.html(loading());
			const [data, core, nav] = await Promise.all([
				tmg('get_trip_website', { trip }).catch(() => null),
				tcc('get_trips_list', { search: trip, limit: 1 }),
				// Nav row aras trip kongsi (#tm-trip-navrow — same level dgn
				// trip directory; Nov 2026). null bila gagal — row kekal
				// dipapar dgn prev/next disabled.
				fetchTripNav(trip).catch(() => null),
				// Format paparan tarikh Travel Website — kad TRIP INFORMATION
				// (Created) & semua paparan tarikh halaman ini.
				webFmtLoad(),
			]);
			if (!data) {
				$body.html('<p class="text-muted small p-4">Travel date/trip tidak dijumpai.</p>');
				return;
			}
			const info = (core?.trips || []).find((t) => t.name === trip);
			set_trip_title(info?.trip_name || trip);
			breadcrumb([
				{ label: 'Travel Manager', route: ['travel-manager'] },
				{ label: 'Trip', route: ['travel-manager', 'trip'] },
				{ label: info?.trip_name || trip, route: ['travel-manager', 'trip', trip] },
				{ label: 'Website' },
			]);

			// [Nov 2026] Medan segment dibuang daripada doctype Trip
			// Itinerary — modal itineraryDayDialog dikongsi dengan kad
			// override Travel Date / Package Offer.
			const web = {
				scalar: {
					title: data.title || '', route: data.route || '',
					// Status trip (Select doctype: Pending Review / Active /
					// Completed / Cancelled) — dikemas kini dari kad CONTENT.
					status: data.status || 'Pending Review',
					published: !!data.published, video_url: data.video_url || '',
					trip_image: data.trip_image || '', description: data.description || '',
					featured_trip: !!data.featured_trip,
					meta_title: data.meta_title || '',
					meta_description: data.meta_description || '',
					meta_image: data.meta_image || '',
					meta_noindex: !!data.meta_noindex,
				},
				gallery: data.gallery || [],
				itinerary: (data.itinerary || []).map((r) => ({ ...r })),
				highlights: (data.highlights || []).map((r) => ({ ...r })),
				features: (data.features || []).map((r) => ({ ...r })),
				faqs: (data.faqs || []).map((r) => ({ ...r })),
				facilities: (data.facilities || []).map((r) => ({ ...r })),
			};

			// ── Baca SEMUA input DOM → web (sebelum Save / re-render) ──
			const readInputs = () => {
				$body.find('[data-f]').each(function () {
					const f = $(this).data('f');
					web.scalar[f] = $(this).is(':checkbox') ? ($(this).is(':checked') ? 1 : 0) : $(this).val();
				});
				$body.find('[data-i][data-c]').each(function () {
					const tbl = $(this).closest('[data-tbl]').data('tbl');
					const row = web[tbl] && web[tbl][$(this).data('i')];
					if (!row) return;
					row[$(this).data('c')] = $(this).is(':checkbox')
						? ($(this).is(':checked') ? 1 : 0) : $(this).val();
				});
				// Controls stok (Quill/Attach Image) — baca get_value() terus
				// supaya state kekal semasa re-render (tambah/buang baris)
				// DAN Save per-kad; event change control ini tak boleh
				// diharap.
				if (wsCtrls.description) web.scalar.description = wsCtrls.description.get_value() || '';
				if (wsCtrls.trip_image) web.scalar.trip_image = wsCtrls.trip_image.get_value() || '';
				if (wsCtrls.meta_image) web.scalar.meta_image = wsCtrls.meta_image.get_value() || '';
			};

			// ── Controls stok Frappe (Text Editor = Quill, Attach Image =
			//    dialog upload) TIDAK menghasilkan event $input yang boleh
			//    diharap — nilai dibaca TERUS daripada control semasa Save
			//    (wsCtrls), bukan melalui callback change.
			const wsCtrls = {};

			// ── Save per-kad (Nov 2026) — setiap kad simpan BAHAGIANNYA
			//    SAHAJA: payload separa, save_trip_website hanya menulis
			//    medan/jadual yang HADIR dalam payload (medan kad lain tak
			//    disentuh). Galeri tiada Save — upload/buang fail berlaku
			//    serta-merta melalui endpoint berasingan. readInputs()
			//    global dulu supaya state `web` sentiasa segar (re-render
			//    selepas tambah/buang baris tidak hilangkan suntingan). ──
			const WS_CARD_SCALARS = {
				content: ['title', 'route', 'status', 'published',
					'featured_trip', 'trip_image', 'video_url', 'description'],
				seo: ['meta_title', 'meta_description', 'meta_image', 'meta_noindex'],
			};
			const WS_CARD_TABLES = ['itinerary', 'highlights', 'facilities', 'features', 'faqs'];
			const WS_CARD_LABEL = {
				content: 'Content', itinerary: 'Itinerary', highlights: 'Highlights',
				facilities: 'Facilities', features: 'Features', faqs: 'FAQ', seo: 'SEO',
			};
			const saveCard = async (key, $btn) => {
				readInputs();
				const payload = { trip };
				(WS_CARD_SCALARS[key] || []).forEach((f) => { payload[f] = web.scalar[f]; });
				if (WS_CARD_TABLES.includes(key)) payload[key] = web[key];
				const $b = $btn.prop('disabled', true);
				try {
					const r = await tmg('save_trip_website', { payload });
					// Content: route auto-jana dalam validate controller —
					// papar slug sebenar; badge Status/Published/Featured
					// kad TRIP INFO dikemas kini TANPA reload penuh
					// (suntingan kad lain yang belum disimpan kekal).
					if (key === 'content') {
						if (r?.route) $body.find('[data-f="route"]').val(r.route);
						if (info) {
							info.status = payload.status;
							info.published = !!payload.published;
							info.featured = !!payload.featured_trip;
						}
						$body.find('#tm-ws-info-wrap').html(
							tripInfoCardHtml(info || { is_a_cruise_trip: 0 }, trip));
					}
					frappe.show_alert({
						message: `${WS_CARD_LABEL[key] || 'Kandungan'} website disimpan`,
						indicator: 'green',
					});
				} catch (e) { /* frappe already shows it */ }
				$b.prop('disabled', false);
			};

			// ── FAQ (Nov 2026 — susun atur arahan pemilik): SENARAI BARIS
			// COLLAPSIBLE (bukan jadual berkolum) — setiap item: soalan
			// (klik → jawapan terexpand di bawah) + mini butang ✏️ sunting
			// (modal) & ✕ buang; carian menapis item. Tambah pukal daripada
			// master Trip FAQ Template. faqOpen — Set item yang jawapannya
			// sedang dibuka (baris = rujukan objek web.faqs); faqQuery —
			// kata carian semasa (kekal merentas re-render kad). ──
			const faqOpen = new Set();
			let faqQuery = '';
			const faqItemHtml = (r) => {
				const i = web.faqs.indexOf(r);
				const open = faqOpen.has(r);
				return `
					<div class="tm-faq-item${open ? ' tm-faq-item-open' : ''}" data-faq-i="${i}">
						<div class="d-flex align-items-start gap-2">
							<a class="tm-faq-q pointer flex-fill" role="button"
								title="Klik untuk papar/sorok jawapan"><span
								class="tm-faq-caret">${open ? '▾' : '▸'}</span>${esc(r.question || '(kosong)')}</a>
							<button class="btn btn-xs btn-default tm-faq-edit" data-faq-i="${i}"
								title="Sunting FAQ ini (modal)">✏️</button>
							<button class="btn btn-xs btn-danger tm-ws-row-del" data-tbl="faqs"
								data-i="${i}" title="Buang FAQ ini">✕</button>
						</div>
						<div class="tm-faq-ans-body" style="display:${open ? 'block' : 'none'}">${r.answer || ''}</div>
					</div>`;
			};
			const renderFaqList = (q = '') => {
				const ql = String(q || '').trim().toLowerCase();
				const list = web.faqs.filter((r) => !ql
					|| (r.question || '').toLowerCase().includes(ql));
				const $mount = $body.find('#tm-ws-faq-dt');
				$mount.html(list.length
					? list.map(faqItemHtml).join('')
					: `<p class="text-muted small my-2">${ql
						? 'Tiada padanan carian.'
						: 'Tiada FAQ — klik "＋ FAQ Baharu" atau "📋 Dari Template".'}</p>`);
				$body.find('#tm-ws-faq-count').text(list.length === web.faqs.length
					? `${web.faqs.length} soalan`
					: `${list.length} / ${web.faqs.length} soalan`);
				// Binding TERUS pada item baharu (idiom halaman — semua butang
				// lain juga binding terus selepas render; delegasi $body tak
				// sempoi untuk kad ni). faqOpen kekalkan status terbuka
				// merentas carian & re-render.
				// INDEKS dibaca daripada .tm-faq-item TERDEKAT (data-faq-i
				// ada pada item; [FIX] anchor dulu tiada atribut ini — klik
				// keluar senyap kerana row undefined).
				$mount.find('.tm-faq-q').on('click', function () {
					const row = web.faqs[$(this).closest('.tm-faq-item').data('faq-i')];
					if (!row) return;
					if (faqOpen.has(row)) faqOpen.delete(row); else faqOpen.add(row);
					const $item = $(this).closest('.tm-faq-item')
						.toggleClass('tm-faq-item-open', faqOpen.has(row));
					$item.find('.tm-faq-caret').first()
						.text(faqOpen.has(row) ? '▾' : '▸');
					$item.find('.tm-faq-ans-body').first()
						.toggle(faqOpen.has(row));
				});
				$mount.find('.tm-faq-edit').on('click', function () {
					const row = web.faqs[$(this).closest('.tm-faq-item').data('faq-i')];
					if (row) faqDialog(row, () => render());
				});
			};
			const faqDialog = (row, onSave) => {
				const d = new frappe.ui.Dialog({
					title: row._is_new ? '＋ FAQ Baharu' : '✏️ Sunting FAQ',
					fields: [
						{ fieldname: 'question', fieldtype: 'Data', label: 'Soalan (FAQ Question)',
							reqd: 1, default: row.question || '',
							description: 'Soalan dipapar di seksyen FAQ laman web.' },
						{ fieldname: 'answer', fieldtype: 'Text Editor', label: 'Jawapan (FAQ Answer)',
							default: row.answer || '' },
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
				return d;
			};
			const openFaqTemplateDialog = async () => {
				const tpls = await tmg('get_faq_templates').catch(() => null) || [];
				if (!tpls.length) {
					frappe.msgprint('Tiada FAQ Template didaftarkan lagi — urus senarai '
						+ 'template di Desk (Module Travel Booking → Trip FAQ Template).');
					return;
				}
				// 200+ template — kumpul ikut TOPIC + carian semasa menaip.
				const groups = {};
				tpls.forEach((t) => {
					const k = t.topic || 'Lain-lain';
					(groups[k] = groups[k] || []).push(t);
				});
				const d = new frappe.ui.Dialog({
					title: '📋 Tambah FAQ dari Template',
					fields: [{
						fieldname: 'tpl_list', fieldtype: 'HTML',
						options: `
							<input class="form-control form-control-sm mb-2" id="tm-faq-tpl-q"
								placeholder="Cari soalan template…" aria-label="Cari template">
							<div style="max-height:50vh;overflow:auto">
							${Object.keys(groups).sort().map((k) => `
								<h6 class="mt-2 mb-1 text-muted text-uppercase" style="font-size:.75rem">${esc(k)}</h6>
								${groups[k].map((t) => { const i = tpls.indexOf(t); return `
								<div class="custom-control custom-checkbox mb-1 tm-faq-tpl-item"
									data-q="${esc((t.question || '').toLowerCase())}">
									<input type="checkbox" class="custom-control-input tm-faq-tpl-chk"
										id="tm-faq-tpl-${i}" data-tpl-i="${i}">
									<label class="custom-control-label" for="tm-faq-tpl-${i}">
										${esc(t.question || '')}
									</label>
								</div>`; }).join('')}
							`).join('')}
							</div>`,
					}],
					primary_action_label: 'Tambah Dipilih',
					primary_action: () => {
						const picks = [];
						d.$wrapper.find('.tm-faq-tpl-chk:checked').each(function () {
							picks.push(tpls[$(this).data('tpl-i')]);
						});
						if (!picks.length) {
							frappe.msgprint('Tandakan sekurang-kurangnya satu template.');
							return;
						}
						picks.forEach((t) => web.faqs.push({
							question: t.question || '', answer: t.answer || '' }));
						d.hide();
						render();
						frappe.show_alert({ message: `${picks.length} FAQ ditambah dari template`,
							indicator: 'green' });
					},
				});
				d.show();
				// Penapis template — sorok baris yang soalannya tidak sepadan.
				d.$wrapper.find('#tm-faq-tpl-q').on('input', function () {
					const q = String($(this).val() || '').toLowerCase();
					d.$wrapper.find('.tm-faq-tpl-item').each(function () {
						$(this).toggle(!q || ($(this).data('q') || '').includes(q));
					});
				});
				return d;
			};

			const render = () => {
			// Nav row aras TRIP kongsi (#tm-trip-navrow — All Trips / Prev /
			// Next / Delete, sama level dgn trip directory; Nov 2026).
			// [Nov 2026] Save Website global dibuang — ganti Save per-kad
			// di bawah card-body setiap kad (wsSaveFooter / saveCard).
			const navRow = tripNavRowHtml(trip, nav);

			// ── Kad website — COLLAPSIBLE + Save per-kad di bawah body
			// (Nov 2026): klik header buka/tutup body (caret ▸/▾, status
			// kekal via wsOpen); body TUTUP secara lalai
			// (style="display:none"). Butang Save di BAWAH card-body —
			// BUKAN card-footer berasingan (card-footer kekal untuk kad
			// TRIP INFORMATION sahaja). `key` = data-ws-card — skop
			// payload save per-kad. Galeri dipanggil TANPA Save
			// (upload/buang imej serta-merta). ──
			const wsCard = (key, title, inner, footer) => `
				<div class="card mb-3" data-ws-card="${key}">
					<div class="card-header d-flex flex-wrap align-items-center gap-2 text-body tm-ws-card-toggle">
						<span class="tm-ws-caret" aria-hidden="true">▸</span>${title}
					</div>
					<div class="card-body tm-ws-card-body" style="display:none">${inner || ''}
						${footer ? `<div class="mt-3 d-flex justify-content-end">${footer}</div>` : ''}</div>
				</div>`;
			const wsSaveFooter = (key, label) => `
				<button class="btn btn-primary btn-sm" data-ws-save="${key}"
					title="Simpan bahagian ${label} sahaja">💾 Save ${label}</button>`;

			// ── Kad CONTENT — grid 4 baris (Nov 2026): Title 12/12 ·
			// Route + Status + Published + Featured 3/3/3/3 (status trip
			// boleh dikemas kini di sini — select opsyen doctype Trip) ·
			// Cover + Video 6/6 · Description 12/12. field(tight) —
			// padding clearfix py-1/px-2 dibuang; jarak diurus gutter grid
			// biasa (.row TANPA no-gutters). Cover diberi pratonton imej;
			// Video URL YouTube diberi pratonton thumbnail.
			const contentCard = wsCard('content', `📝 CONTENT`, `
				<div class="row">
					${field('Title (H1 web)', `<input class="form-control form-control-sm" data-f="title"
						value="${esc(web.scalar.title)}" placeholder="Lalai = Trip Name">`, 'col-12', true)}
					${field('Route (slug)', `<input class="form-control form-control-sm text-monospace" data-f="route"
						value="${esc(web.scalar.route)}" placeholder="trips/… (kosong = auto-jana)">`, 'col-12 col-md-3', true)}
					${field('Status', `<select class="form-control form-control-sm" data-f="status">
						${['Pending Review', 'Active', 'Completed', 'Cancelled'].map((s) => `
						<option value="${s}" ${web.scalar.status === s ? 'selected' : ''}>${s}</option>`).join('')}
					</select>`, 'col-12 col-md-3', true)}
					${field('Published (web)', `<div class="custom-control custom-switch">
						<input type="checkbox" class="custom-control-input" id="tm-ws-published" data-f="published"
							${web.scalar.published ? 'checked' : ''}>
						<label class="custom-control-label" for="tm-ws-published">published</label></div>`, 'col-12 col-md-3', true)}
					${field('Featured Trip', `<div class="custom-control custom-switch">
						<input type="checkbox" class="custom-control-input" id="tm-ws-featured" data-f="featured_trip"
							${web.scalar.featured_trip ? 'checked' : ''}>
						<label class="custom-control-label" for="tm-ws-featured">Featured</label></div>`, 'col-12 col-md-3', true)}
					${field('Cover Photo', '<div id="tm-ws-trip-image"></div>' +
						'<img id="tm-ws-cover-preview" class="tm-ws-cover-preview" alt="cover preview">', 'col-12 col-md-6', true)}
					${field('Video URL (YouTube)', `<input class="form-control form-control-sm" data-f="video_url"
						value="${esc(web.scalar.video_url)}" placeholder="https://youtube.com/watch?v=…">
						<img id="tm-ws-yt-preview" class="tm-ws-yt-preview" alt="video thumbnail"
							title="Klik untuk buka video">`, 'col-12 col-md-6', true)}
					${field('Trip Description', '<div id="tm-ws-description"></div>', 'col-12', true)}
				</div>`, wsSaveFooter('content', 'Content'));

			// ── Kad GALLERY — klik thumbnail → lightbox papar besar + slide ──
			const galleryCard = wsCard('gallery', `🖼️ GALLERY (${web.gallery.length} imej)`, `
				<div class="d-flex flex-wrap gap-2 mb-2">
					<button class="btn btn-default btn-sm" id="tm-ws-upload">⬆ Upload Imej</button>
					<span class="text-muted small align-self-center">Fail dilampir pada trip ini (public sahaja dipapar web). Klik imej untuk papar besar.</span>
				</div>
				<div class="d-flex flex-wrap gap-2" id="tm-ws-gallery">
					${web.gallery.map((g, gi) => `
					<div class="tm-ws-thumb" data-gi="${gi}" title="Klik untuk papar besar">
						<img src="${esc(g.file_url)}" alt="gallery">
						<button class="btn btn-xs btn-danger tm-ws-img-del" data-file="${esc(g.file_name)}"
							title="Buang imej ini">✕</button>
					</div>`).join('') || '<span class="text-muted small">Tiada imej lagi.</span>'}
				</div>`);

			// ── Kad ITINERARY ── senarai ringkas (Day + Day Title sahaja);
			// tambah/sunting penuh melalui modal (itineraryDayDialog —
			// helper kongsi dengan kad override Travel Date / Package Offer).
			const itRow = (r, i) => `
				<tr data-tbl="itinerary" data-i="${i}">
					<td class="tm-itin-drag" title="Seret untuk susun semula">⠿</td>
					<td style="width:70px" class="text-muted">${esc(r.day ?? '')}</td>
					<td>${esc(r.day_title || '')}${r.day_image
						? ' <span title="Ada imej hari">🖼️</span>' : ''}</td>
					<td class="text-nowrap" style="width:90px">
						<button class="btn btn-xs btn-default tm-ws-it-edit" data-tbl="itinerary"
							data-i="${i}" title="Sunting hari">✏️</button>
						<button class="btn btn-xs btn-danger tm-ws-row-del"
							data-tbl="itinerary" data-i="${i}" title="Buang baris">✕</button>
					</td>
				</tr>`;
			// [BUANG Nov 2026] itinerary_title/caption dari doctype — header
			// kad papar jumlah hari sahaja.
			const itineraryCard = wsCard('itinerary', `🗓️ ITINERARY (${web.itinerary.length} hari)`, `
				<div class="table-responsive">
				<table class="table table-sm mb-0" data-tbl="itinerary">
					<thead><tr><th style="width:30px"></th><th style="width:70px">Day</th><th>Day Title</th><th></th></tr></thead>
					<tbody>${web.itinerary.map(itRow).join('')
						|| '<tr><td colspan="4" class="text-muted small">Tiada hari — klik "+ Hari".</td></tr>'}</tbody>
				</table></div>
				<button class="btn btn-default btn-sm mt-2" id="tm-ws-it-add">+ Hari</button>`,
				wsSaveFooter('itinerary', 'Itinerary'));

			// ── Kad HIGHLIGHTS & FACILITIES — kad BERASINGAN (Nov 2026,
			// dahulunya satu kad dua kolum) ──
			const hlCard = wsCard('highlights', `⭐ HIGHLIGHTS (${web.highlights.length})`, `
				<div data-tbl="highlights">
				${web.highlights.map((r, i) => `
					<div class="d-flex gap-1 mb-1" data-tbl="highlights">
						<input class="form-control form-control-sm" data-i="${i}" data-c="highlight"
							value="${esc(r.highlight || '')}" placeholder="Highlight teks">
						<button class="btn btn-xs btn-danger tm-ws-row-del" data-tbl="highlights"
							data-i="${i}">✕</button>
					</div>`).join('')}
				<button class="btn btn-default btn-sm" id="tm-ws-hl-add">+ Highlight</button>
				</div>`, wsSaveFooter('highlights', 'Highlights'));

			const facCard = wsCard('facilities', `🏨 FACILITIES (${web.facilities.length})`, `
				<div data-tbl="facilities">
				${web.facilities.map((r, i) => `
					<div class="d-flex gap-1 mb-1" data-tbl="facilities">
						<input class="form-control form-control-sm" style="flex:0 0 64px" data-i="${i}" data-c="icon"
							value="${esc(r.icon || '')}" placeholder="🛎️">
						<input class="form-control form-control-sm" data-i="${i}" data-c="facility"
							value="${esc(r.facility || '')}" placeholder="Nama facility">
						<button class="btn btn-xs btn-danger tm-ws-row-del" data-tbl="facilities"
							data-i="${i}">✕</button>
					</div>`).join('')}
				<button class="btn btn-default btn-sm" id="tm-ws-fa-add">+ Facility</button>
				</div>`, wsSaveFooter('facilities', 'Facilities'));

			// ── Kad FEATURES (Included / Excluded) ──
			const ftCard = wsCard('features', `✅ INCLUDED / EXCLUDED FEATURES (${web.features.length})`, `
				<div data-tbl="features">
				${web.features.map((r, i) => `
					<div class="d-flex gap-2 align-items-center mb-1" data-tbl="features">
						<div class="custom-control custom-switch" style="width:110px">
							<input type="checkbox" class="custom-control-input" id="tm-ws-ft-${i}"
								data-i="${i}" data-c="included" ${r.included ? 'checked' : ''}>
							<label class="custom-control-label" for="tm-ws-ft-${i}">Included</label>
						</div>
						<input class="form-control form-control-sm" data-i="${i}" data-c="feature"
							value="${esc(r.feature || '')}" placeholder="Feature teks">
						<button class="btn btn-xs btn-danger tm-ws-row-del" data-tbl="features"
							data-i="${i}">✕</button>
					</div>`).join('')}
				<button class="btn btn-default btn-sm" id="tm-ws-ftr-add">+ Feature</button>
				</div>`, wsSaveFooter('features', 'Features'));

			// ── Kad FAQ — senarai baris COLLAPSIBLE + carian; daftar/sunting
			// FAQ melalui MODAL; butang template → Trip FAQ Template master.
			const faqCard = wsCard('faqs', `❓ FAQ (${web.faqs.length})`, `
				<div class="d-flex flex-wrap gap-2 align-items-center mb-2">
					<button class="btn btn-default btn-sm" id="tm-ws-faq-add"
						title="Daftar FAQ baharu melalui borang modal">＋ FAQ Baharu</button>
					<button class="btn btn-default btn-sm" id="tm-ws-faq-tpl"
						title="Tambah FAQ daripada senarai template">📋 Dari Template</button>
					<input id="tm-ws-faq-search" class="form-control form-control-sm ml-auto"
						style="max-width:220px" placeholder="Cari soalan…"
						value="${esc(faqQuery)}" aria-label="Cari soalan FAQ">
				</div>
				<div id="tm-ws-faq-count" class="text-muted text-small mb-1"></div>
				<div id="tm-ws-faq-dt"></div>`, wsSaveFooter('faqs', 'FAQ'));

			// ── Kad SEO & LISTING — susun atur 4 baris (Nov 2026): Meta
			// Title 12/12 · Meta Description 12/12 · Meta Image 12/12 ·
			// noindex 12/12. Butang ✨ Auto Fill mengisi ketiga-tiga medan
			// meta ikut cadangan SEO (title ≤ 60 aksara, description ≤ 160,
			// image = Cover Photo / imej galeri pertama). Pembilang aksara
			// menunjukkan status had (hijau ≤ had, merah > had).
			// [BUANG] Featured Trip (ke kad CONTENT) & Itinerary Title/
			// Caption (dibuang daripada doctype). ──
			const seoCard = wsCard('seo', `🔎 SEO & LISTING
				<button class="btn btn-xs btn-default ml-auto" id="tm-ws-seo-auto"
					title="Isi automatik ikut cadangan SEO: meta title ≤ 60 aksara, meta description ≤ 160 aksara, meta image = Cover Photo / imej galeri pertama">✨ Auto Fill SEO</button>`, `
				<div class="row">
					${field('Meta Title', `<input class="form-control form-control-sm" data-f="meta_title"
						value="${esc(web.scalar.meta_title)}" placeholder="< 60 aksara">
						<span class="tm-seo-count" data-count-for="meta_title"></span>`, 'col-12', true)}
					${field('Meta Description', `<textarea class="form-control form-control-sm" rows="3"
						data-f="meta_description" placeholder="< 160 aksara">${esc(web.scalar.meta_description)}</textarea>
						<span class="tm-seo-count" data-count-for="meta_description"></span>`, 'col-12', true)}
					${field('Meta Image (OG)', '<div id="tm-ws-meta-image"></div>', 'col-12', true)}
					${field('Hide from Search (noindex)', `<div class="custom-control custom-switch">
						<input type="checkbox" class="custom-control-input" id="tm-ws-noindex" data-f="meta_noindex"
							${web.scalar.meta_noindex ? 'checked' : ''}>
						<label class="custom-control-label" for="tm-ws-noindex">noindex</label></div>`, 'col-12', true)}
				</div>`, wsSaveFooter('seo', 'SEO'));

			// ── Lightbox galeri — overlay tetap (dibuka oleh klik thumbnail;
			// ditutup ✕/backdrop/Esc). Dilampir di akhir $body — lenyap
			// automatik bila halaman di-render semula. ──
			const lightboxHtml = `
				<div id="tm-ws-lightbox" class="tm-ws-lightbox" style="display:none">
					<div class="tm-ws-lb-backdrop"></div>
					<div class="tm-ws-lb-stage"><img id="tm-ws-lb-img" alt="gallery image"></div>
					<button class="tm-ws-lb-btn tm-ws-lb-close" title="Tutup (Esc)">✕</button>
					<button class="tm-ws-lb-btn tm-ws-lb-prev" title="Sebelum (←)">‹</button>
					<button class="tm-ws-lb-btn tm-ws-lb-next" title="Seterusnya (→)">›</button>
					<div class="tm-ws-lb-caption"><span id="tm-ws-lb-count"></span></div>
				</div>`;

			$body.html(`${navRow}
				<div id="tm-ws-info-wrap" class="mb-3">${tripInfoCardHtml(info || { is_a_cruise_trip: 0 }, trip)}</div>
				${contentCard}${galleryCard}${itineraryCard}${hlCard}${facCard}${ftCard}${faqCard}${seoCard}${lightboxHtml}`);

			// ── Controls stok Frappe (dibina selepas render). Nilai TIDAK
			//    di-track melalui event change (Quill/Attach tak emit
			//    $input.change yang boleh diharap) — readInputs() membaca
			//    get_value() terus (re-render & Save per-kad). ──

			// ── Pratonton: Cover Photo (imej penuh) & Video URL (thumbnail
			// YouTube). Cover — dikemas kini melalui df.change Attach Image
			// (dipanggil oleh set_value selepas upload/clear); Video — event
			// input biasa pada text input. ──
			const ytId = (u) => {
				const m = String(u || '').match(
					/(?:youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|embed\/|live\/)|youtu\.be\/)([A-Za-z0-9_-]{6,})/);
				return m ? m[1] : '';
			};
			const updateCoverPreview = () => {
				const url = String(wsCtrls.trip_image?.get_value() || '').trim();
				$body.find('#tm-ws-cover-preview').toggle(!!url).attr('src', url || '');
			};
			const updateYtPreview = () => {
				const url = String($body.find('[data-f="video_url"]').val() || '').trim();
				const id = ytId(url);
				const $p = $body.find('#tm-ws-yt-preview');
				if (id) $p.show().attr('src', `https://i.ytimg.com/vi/${id}/hqdefault.jpg`).data('url', url)
					// ytimg tidak dapat dicapai → sembunyikan (elak imej rosak)
					.off('error').on('error', () => $p.hide());
				else $p.hide().attr('src', '').removeData('url');
			};

			const mkCtrl = (el, df, value) => {
				if (!el) return null;
				const ctrl = frappe.ui.form.make_control({
					parent: el, df, render_input: true,
					// only_input — wrapper mudah TANPA <div class="clearfix">
					// (label kosong + help) warisan template base_input; label
					// halaman sudah disediakan field() — arahan pemilik.
					only_input: true,
				});
				if (value) ctrl.set_value(value);
				return ctrl;
			};
			wsCtrls.description = mkCtrl($body.find('#tm-ws-description')[0],
				{ fieldtype: 'Text Editor', fieldname: 'ws_description' },
				web.scalar.description);
			wsCtrls.trip_image = mkCtrl($body.find('#tm-ws-trip-image')[0],
				{ fieldtype: 'Attach Image', fieldname: 'ws_trip_image',
					// pratonton cover berubah bila Attach upload/clear (set_value
					// memanggil df.change) — Nov 2026
					change: updateCoverPreview,
					// ControlAttach merge df.options ke opsyen FileUploader
					// (attach.js set_upload_options) — pastikan upload imej
					// web sentiasa PUBLIC (checkbox Private dibuang).
					options: { make_attachments_public: true, allow_toggle_private: false } },
				web.scalar.trip_image);
			wsCtrls.meta_image = mkCtrl($body.find('#tm-ws-meta-image')[0],
				{ fieldtype: 'Attach Image', fieldname: 'ws_meta_image',
					options: { make_attachments_public: true, allow_toggle_private: false } },
				web.scalar.meta_image);
			// FAQ — render senarai collapsible (faqQuery kekal merentas
			// re-render kad; item = rujukan objek web.faqs, indexOf → indeks
			// stabil untuk data-faq-i walau ditapis).
			renderFaqList(faqQuery);
			updateCoverPreview();
			updateYtPreview();
			$body.find('[data-f="video_url"]').on('input change', updateYtPreview);
			$body.find('#tm-ws-yt-preview').on('click', function () {
				const u = $(this).data('url');
				if (u) window.open(u, '_blank');
			});

			// ── SEO auto-fill + pembilang aksara (Nov 2026) — nilai ikut
			// cadangan SEO: meta title ≤ 60, meta description ≤ 160, meta
			// image (OG) = Cover Photo / imej galeri pertama (diisi hanya
			// bila kosong — OG pilihan sedia ada tidak ditindih). ──
			const seoTruncate = (s, n) => {
				s = String(s || '').replace(/\s+/g, ' ').trim();
				if (s.length <= n) return s;
				const cut = s.slice(0, n - 1);
				const sp = cut.lastIndexOf(' ');
				return (sp > Math.floor(n * 0.6) ? cut.slice(0, sp) : cut).trim() + '…';
			};
			// Huraian HTML daripada Text Editor milik pengguna sendiri —
			// teks sahaja dikira untuk meta description.
			const seoPlainText = (html) =>
				$('<div>').html(html || '').text().replace(/\s+/g, ' ').trim();
			const updateSeoCounters = () => {
				[['meta_title', 60], ['meta_description', 160]].forEach(([f, max]) => {
					const v = String($body.find(`[data-f="${f}"]`).val() || '');
					$body.find(`.tm-seo-count[data-count-for="${f}"]`)
						.text(`${v.length} / ${max} aksara`)
						.toggleClass('tm-seo-over', v.length > max);
				});
			};
			const seoAutoFill = () => {
				// Meta Title — H1 web / nama trip (≤ 60)
				$body.find('[data-f="meta_title"]').val(
					seoTruncate(web.scalar.title || data.trip_name || trip, 60));
				// Meta Description — teks description → highlights → nama trip (≤ 160)
				let desc = seoPlainText(web.scalar.description);
				if (!desc) desc = web.highlights.map((h) => h.highlight)
					.filter(Boolean).join(' • ');
				$body.find('[data-f="meta_description"]').val(
					seoTruncate(desc || data.trip_name || trip, 160));
				// Meta Image — Cover Photo → imej galeri pertama
				const img = web.scalar.trip_image || (web.gallery[0] || {}).file_url || '';
				if (img && wsCtrls.meta_image && !wsCtrls.meta_image.get_value())
					wsCtrls.meta_image.set_value(img);
				updateSeoCounters();
			};
			$body.find('#tm-ws-seo-auto').on('click', seoAutoFill);
			$body.find('[data-f="meta_title"], [data-f="meta_description"]')
				.on('input change', updateSeoCounters);
			updateSeoCounters();
			// (Destination/Port baris itinerary kini disunting melalui modal
			// itineraryDayDialog — tiada kawalan Link inline lagi.)

			// ── Lightbox galeri — klik thumbnail → papar besar; ‹ › slide;
			// ←/→/Esc keyboard; backdrop/klik ✕ tutup. ──
			let lbIdx = 0;
			const lbShow = (i) => {
				if (!web.gallery.length) return;
				lbIdx = ((i % web.gallery.length) + web.gallery.length) % web.gallery.length;
				$('#tm-ws-lb-img').attr('src', web.gallery[lbIdx].file_url);
				$('#tm-ws-lb-count').text(`${lbIdx + 1} / ${web.gallery.length} — ${web.gallery[lbIdx].file_url}`);
				$('#tm-ws-lightbox').find('.tm-ws-lb-prev, .tm-ws-lb-next')
					.toggle(web.gallery.length > 1);
				$('#tm-ws-lightbox').show();
			};
			const lbClose = () => $('#tm-ws-lightbox').hide();
			$body.find('.tm-ws-thumb img').css('cursor', 'pointer').on('click', function () {
				lbShow($(this).parent().data('gi'));
			});
			$body.find('.tm-ws-lb-prev').on('click', () => lbShow(lbIdx - 1));
			$body.find('.tm-ws-lb-next').on('click', () => lbShow(lbIdx + 1));
			$body.find('.tm-ws-lb-close, .tm-ws-lb-backdrop').on('click', lbClose);
			$(document).off('keydown.tm-lb').on('keydown.tm-lb', (e) => {
				if (!$body.find('#tm-ws-lightbox').is(':visible')) return;
				if (e.key === 'Escape') lbClose();
				else if (e.key === 'ArrowLeft') lbShow(lbIdx - 1);
				else if (e.key === 'ArrowRight') lbShow(lbIdx + 1);
			});

			// ── Aksi ──
			// Nav row kongsi (balik ke senarai / prev / next / delete) —
			// wiring dipusatkan di tm_shared.js.
			wireTripNavRow(trip, nav);
			// Save per-kad — butang 💾 di bawah card-body setiap kad
			// (galeri tiada Save — upload/buang fail serta-merta).
			$body.find('[data-ws-save]').on('click', function () {
				saveCard($(this).data('ws-save'), $(this));
			});
			// Kad collapsible — klik header buka/tutup body (caret ▸/▾);
			// klik butang dalam header (cth. ✨ Auto Fill SEO) TIDAK toggle.
			$body.find('.tm-ws-card-toggle').on('click', (e) => {
				if ($(e.target).closest('button').length) return;
				const $card = $(e.currentTarget).closest('[data-ws-card]');
				const key = $card.data('ws-card');
				const $bd = $card.find('.tm-ws-card-body').first();
				const buka = $bd.is(':visible');
				$bd.toggle(!buka);
				$card.find('.tm-ws-caret').first().text(buka ? '▸' : '▾');
				wsOpen[trip] = wsOpen[trip] || {};
				if (!buka) wsOpen[trip][key] = true;  // dibuka pengguna
				else delete wsOpen[trip][key];         // ditutup semula
			});
			// Buka SEMULA hanya kad yang pengguna buka sendiri — default
			// SEMUA TUTUP (re-render / reload tidak membuka kad lain).
			Object.keys(wsOpen[trip] || {}).forEach((key) => {
				if (!wsOpen[trip][key]) return;
				const $card = $body.find(`[data-ws-card="${key}"]`);
				$card.find('.tm-ws-card-body').first().show();
				$card.find('.tm-ws-caret').first().text('▾');
			});
			// Baris tambah/buang child tables — baca input dulu supaya nilai
			// yang baru ditaip tak hilang, kemudian re-render.
			// Itinerary: tambah/sunting penuh dalam modal (senarai kekal
			// ringkas — Day + Day Title sahaja).
			$body.find('#tm-ws-it-add').on('click', () => {
				readInputs();
				const row = { day: web.itinerary.length + 1,
					day_title: '', destination_point: '', meals: '',
					description: '', day_image: '', _is_new: true };
				itineraryDayDialog(row, () => { web.itinerary.push(row); render(); });
			});
			$body.find('.tm-ws-it-edit').on('click', function () {
				readInputs();
				const row = web.itinerary[$(this).data('i')];
				if (row) itineraryDayDialog(row, () => render());
			});
			$body.find('#tm-ws-hl-add').on('click', () => { readInputs(); web.highlights.push({ highlight: '' }); render(); });
			$body.find('#tm-ws-fa-add').on('click', () => { readInputs(); web.facilities.push({ facility: '', icon: '' }); render(); });
			$body.find('#tm-ws-ftr-add').on('click', () => { readInputs(); web.features.push({ feature: '', included: 1 }); render(); });
			$body.find('#tm-ws-faq-add').on('click', () => {
				const row = { question: '', answer: '', _is_new: true };
				faqDialog(row, () => { web.faqs.push(row); render(); });
			});
			$body.find('#tm-ws-faq-tpl').on('click', openFaqTemplateDialog);
			$body.find('#tm-ws-faq-search').on('input', frappe.utils.debounce(
				function () { faqQuery = $(this).val(); renderFaqList(faqQuery); }, 200));
			// Buang baris child tables — DELEGASI $body: butang ✕ FAQ hidup
			// dalam tbody tmDataTable yang dirender semula (carian/pagination)
			// — delegasi kekal hidup untuk semua kad.
			$body.off('click.tmrowdel').on('click.tmrowdel', '.tm-ws-row-del',
				function () {
					readInputs();
					const tbl = $(this).data('tbl');
					const i = $(this).data('i');
					web[tbl].splice(i, 1);
					// Nombor hari kekal berurutan selepas buang baris itinerary.
					if (tbl === 'itinerary') {
						web.itinerary.forEach((r, i2) => { r.day = i2 + 1; });
					}
					render();
				});
			// Drag-to-reorder hari — nombor hari ikut susunan baharu
			// (wireItinSortable kongsi dengan kad override; simpan melalui
			// butang 💾 Save Itinerary seperti biasa).
			wireItinSortable($body.find('table[data-tbl="itinerary"] tbody'),
				web.itinerary, () => render());
			// Galeri — upload (FileUploader melampir pada Trip) & buang.
			$body.find('#tm-ws-upload').on('click', () => {
				new frappe.ui.FileUploader({
					doctype: 'Trip', docname: trip,
					// Galeri web hanya memaparkan fail public (API menapis
					// is_private=0) — jadi upload di sini sentiasa PUBLIC:
					// default unchecked + checkbox Private dibuang.
					make_attachments_public: true,
					allow_toggle_private: false,
					restrictions: { allowed_file_types: ['image/*'] },
					on_success: () => {
						frappe.show_alert({ message: 'Imej dimuat naik', indicator: 'green' });
						load_trip_website(trip);
					},
				});
			});
			$body.find('.tm-ws-img-del').on('click', function () {
				const file = $(this).data('file');
				frappe.confirm('Buang imej ini daripada galeri trip?', () => {
					tmg('remove_trip_gallery_file', { trip, file_name: file })
						.then(() => load_trip_website(trip))
						.catch(() => {});
				});
			});

			};
			render();
		}

		function set_trip_title(name) {
			// directory: update the last breadcrumb segment (subtitle
			// tm-dir-subtitle dibuang — Nov 2026, tiada kegunaan).
			$bc.find('strong').last().text(name);
		}

		// [BUANG Nov 2026] pick_schedule_dialog — pautan schedule per-TRIP
		// dibuang (set_trip_cruise_schedule); schedule dipaut pada
		// peringkat TRAVEL DATE (halaman tarikh → dialog Edit Date,
		// Selected Cruise Schedule).

		function fa_dialog(fa, trip, onDone) {
			const d = new frappe.ui.Dialog({
				title: 'Flight Arrangement — ' + trip,
				fields: [
					{ fieldname: 'flight_mode', fieldtype: 'Select', label: 'Mode',
						options: 'Return\nMulti-City', default: fa?.flight_mode || 'Return', reqd: 1 },
					{ fieldname: 'home_airport', fieldtype: 'Link', label: 'Home Airport (Departure)',
						options: 'Flight Airport', reqd: 1, default: fa?.home_airport },
					{ fieldname: 'final_destination', fieldtype: 'Link', label: 'Final Destination (Return)',
						options: 'Flight Airport', default: fa?.final_destination },
					{ fieldname: 'via_airports', fieldtype: 'Data',
						label: 'Via (Multi-City, comma separated)', default: (fa?.via_airports || []).join(', ') },
					{ fieldname: 'preferred_airline', fieldtype: 'Link', label: 'Preferred Airline',
						options: 'Flight Airline', default: fa?.preferred_airline },
					{ fieldname: 'notes', fieldtype: 'Small Text', label: 'Notes', default: fa?.notes },
				],
			});
			d.set_primary_action(__('Save'), async () => {
				const v = d.get_values();
				if (!v) return;
				try {
					await tlinks('save_flight_arrangement', { values: JSON.stringify({
						trip,
						flight_mode: v.flight_mode,
						home_airport: v.home_airport,
						final_destination: v.flight_mode === 'Return' ? v.final_destination : '',
						preferred_airline: v.preferred_airline || '',
						notes: v.notes || '',
						via_airports: (v.via_airports || '').split(',').map((s) => s.trim()).filter(Boolean),
					}) });
					frappe.show_alert({ message: 'Flight arrangement saved', indicator: 'green' });
					d.hide();
					onDone && onDone();
				} catch (e) { /* frappe already shows it */ }
			});
			d.show();
		}

		// [BUANG Nov 2026 — PURGE Travel Package] package_dialog (editor
		// Travel Package: get_package_detail/save_package) — dead code
		// (tiada pemanggil dalam page); laluan sah: Add Offer (offer_name
		// + currency) pada halaman tarikh.


		// [BUANG Stage 2 Nov 2026] offer_dialog (package + departure_date
		// terus) — dead code & penjanakan offer stray tanpa Travel Date;
		// generate_offer_from_template kini wajib travel_date. Laluan
		// sah: add_offer_to_date pada halaman tarikh.
