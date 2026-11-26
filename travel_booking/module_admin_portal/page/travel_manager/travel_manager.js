// travel_booking/module_admin_portal/page/travel_manager/travel_manager.js
// TRAVEL MANAGER v8.2 — TOP HEADER NAVIGATION + MOBILE APP
// (v6: directory + left nav panel; v7: table list + grid; v8: left nav panel
//  replaced by a gradient APP BAR at the top — brand + tabs — and a native
//  app feel on phones; lists become cards <992px; v8.1: on phones the nav
//  moved from a bottom bar into a MENU PANEL opened by the ☰ app bar button,
//  so Frappe's own phone nav (bottom bar) stays untouched;
//  v9 MIGRASI CSS GLOBAL (Nov 2026): komponen custom diganti KOMPONEN STOK
//  Bootstrap Frappe (desk.bundle.css) — .card/.card-header/.card-body/
//  .card-footer untuk panel, .breadcrumb untuk tm-bc, .nav-tabs/.tab-pane
//  untuk tab pakej, .table-sm untuk jadual, dan utiliti Bootstrap/
//  Tailwind-named (d-flex/gap-*/text-muted/text-ink-*) untuk layout. CSS
//  page tinggal untuk app bar/menu telefon/shell/odds sahaja.
//  Helper kongsi: loading() secTitle() field() infoGrid().)
//
//   APP BAR (top, sticks on scroll)          CONTENT
//   🧭 Travel Manager            ☰  ⟳        breadcrumb strip
//   [🗺️ Trip ▾][👥 Booking Group][📄 Booking] .tm-body (cards on phone,
//                                              tables ≥992px)
//   🗺️ Trip                 →  trip list → trip directory
//                              (+ 3-step "New Trip" wizard)
//      ├─ 🚢 Cruise Schedule → sailing schedule list → schedule detail
//      │                       (manage Trip Cruise Schedule tanpa akses
//      │                       borang doctype — Nov 2026)
//      ├─ 🎁 Trip Addon      → addon list → addon detail (pakej harga +
//      │                       scoping — sub-menu Trip, Nov 2026)
//      ├─ 📅 Travel Dates    → direktori SEMUA tarikh aras-trip — pantau
//      │                       & urus beramai-ramai (bulk — Nov 2026)
//      └─ 📦 Package Offers  → direktori SEMUA offer aras-trip (bulk)
//   👥 Booking   →  route 'booking' dalam page ini — senarai
//                              FLAT semua booking (tanpa melalui travel
//                              date), created on terkini dahulu (Nov 2026)
//      ├─ 🗂️ Booking Group   → route 'booking-group' — view penuh kumpulan
//      │                       booking (group/batch → detail → booking info
//      │                       → rooming) dipindah daripada route 'booking'
//      │                       (manage-booking-app dideprekat)
//      ├─ 🎁 Addon Booking    → route 'addon-booking' — senarai flat semua
//      │                       Booking Addon merentas trip (Nov 2026)
//      └─ 🧳 Traveller        → route 'traveller' — direktori semua profil
//                              doctype Traveller (Nov 2026)
//
// Trip menu ber-anak: tab Trip dapat caret ▾ — klik buka DROPDOWN
// sub-menu (.tm-nav-sub — Cruise Schedule, Trip Addon, Travel Dates,
// Package Offers); tab itu sendiri kekal navigasi ke senarai trip.
// Pada telefon, anak sub-menu terindent dalam panel menu ☰ (.tm-menu-sub).
//
// PHONE (<768px): the top tabs are hidden — navigation opens from the ☰
// button as a drop-down menu panel under the app bar (with backdrop).
// Frappe's phone nav (bottom bar: Home/Search/…) remains active, which is
// why this page no longer draws its own bottom bar.
//
// ROUTING:
//   /app/travel-manager          → Trip (list)
//   /app/travel-manager/trip     → Trip (list — legacy 'trip-management'
//                                  is still accepted and lands here)
//   /app/travel-manager/trip/new-trip      → 3-step "New Trip" wizard
//                                            (full page, not a modal)
//   /app/travel-manager/trip/<TRIP>        → trip directory
//   /app/travel-manager/cruise-schedule    → Cruise Schedule (list)
//   /app/travel-manager/cruise-schedule/<SCHEDULE> → schedule detail
//   /app/travel-manager/trip-addon         → Trip Addon (list)
//   /app/travel-manager/trip-addon/<ADDON> → addon detail (pakej)
//   /app/travel-manager/travel-dates       → Travel Dates (direktori
//                                            semua tarikh aras-trip)
//   /app/travel-manager/package-offers     → Package Offers (direktori
//                                            semua offer aras-trip)
//   /app/travel-manager/booking            → Booking (senarai
//                                            FLAT semua booking — creation
//                                            DESC, tanpa travel date)
//   /app/travel-manager/booking/<BK>       → PAGE BOOKING ORDER dalam
//                                            direktori senarai ini
//   /app/travel-manager/booking-group      → Booking Group (sub-menu — view
//                                            penuh; booking-group/batch|group
//                                            /<id>, booking-group/<BK>,
//                                            booking-group/rooming/<kind>/<id>,
//                                            booking-group/new = wizard)
//   /app/travel-manager/booking-group/group/<G>/<BK>
//   /app/travel-manager/booking-group/batch/<B>/<BK>
//                                          → PAGE BOOKING ORDER dalam
//                                            direktori group/batch itu
//   /app/travel-manager/addon-booking      → Addon Booking (senarai flat
//                                            semua Booking Addon — creation
//                                            DESC)
//   /app/travel-manager/traveller          → Traveller (direktori semua
//                                            profil doctype Traveller —
//                                            carian server-side)
//   /app/travel-manager/booking-management → dialih ke route 'booking-group'
//                                            (legacy — kandungan dipindah)
//   /app/travel-manager/customer           → Customer (direktori semua
//                                            customer — carian server-side,
//                                            sortable, column-toggle)
//   /app/travel-manager/customer/<NAMA>    → detail customer (info, contacts,
//                                            alamat billing, monitoring
//                                            tunggakan/credit/loyalty,
//                                            bookings, B2B partner)
//   /app/travel-manager/customer/<NAMA>/<BK>
//                                          → PAGE BOOKING ORDER dalam
//                                            direktori customer itu
//
// PAGE BOOKING ORDER (tm_booking_view.js) ialah komponen BEBAS — setiap
// direktori yang berakhir dengan nama booking membukanya TANPA menukar
// direktori (crumb induk kekal, butang kembali ke senarai asal, Prev/Next
// ikut senarai asal). Lihat show_booking_order() di bawah.
//
// All operations go through role-gated APIs — NO direct DocType access.
// Active/Retired/Cancelled approvals: Tour Manager/System Manager only.
// Styling: travel_manager.css (loaded by Page.load_assets as page style).
//
// STRUKTUR FAIL (Nov 2026): page dipecah kepada sub-pakej seksyen
// dalam folder ini dan digabung semula server-side oleh
// frappe.model.utils.render_include (concatenation — scope IIFE
// page kekal sama; corak manage_booking_app). Fail ini = SHELL:
// pendaftaran page, app bar, navigasi, state, router.
//   tm_shared.js          — helper & komponen UI kongsi
//   tm_trip_list.js       — senarai trip (L1)
//   tm_cruise_schedule.js — senarai + detail cruise schedule
//   tm_trip_addon.js      — senarai + detail trip addon (pakej harga)
//   tm_booking_mgmt.js    — booking individu + status flow
//   tm_booking_list.js    — senarai FLAT semua booking (route 'booking')
//   tm_booking.js         — Booking Group: L1 senarai group/batch + L2
//                           detail (controller BookingManagement)
//   tm_booking_view.js    — PAGE BOOKING ORDER (L3) — komponen bebas,
//                           dibuka dalam direktori mana-mana pemanggil
//   tm_traveller_dir.js   — direktori profil traveller (route 'traveller')
//   tm_addon_booking.js   — senarai flat Booking Addon (route
//                           'addon-booking')
//   tm_package_admin.js   — admin travel date & package offer
//   tm_travel_date.js     — date directory (rooming, pakej)
//   tm_dates_directory.js — direktori semua tarikh aras-trip (bulk)
//   tm_trip_directory.js  — trip directory (senarai tarikh)
//   tm_trip_sales.js      — senarai jualan satu trip
//   tm_trip_website.js    — CMS kandungan website trip
//   tm_new_trip_wizard.js — wizard trip baharu
//   tm_customer.js        — direktori + detail customer (Nov 2026)

frappe.pages['travel-manager'].on_page_load = function (wrapper) {
	const page = frappe.ui.make_app_page({
		parent: wrapper,
		title: __('Travel Manager'),
		single_column: true,
		// Frappe's phone nav (bottom bar) stays enabled — this page's own
		// navigation lives in the ☰ menu panel on the app bar instead.
	});

	// Page width follows the Frappe layout setting (User Settings → Layout:
	// Compact / Full Width) — a shortcut to the framework's global toggle,
	// same as the manage-booking-app page.
	page.add_menu_item(__('Toggle Full Width'), () => {
		frappe.ui.toolbar.toggle_full_width();
	});

	// App bar (top header) — replaces the default .page-head content;
	// Frappe's page-head is sticky, so this bar stays glued on scroll.
	wrapper.querySelector('.page-head').innerHTML = `
		<div class="tm-appbar-container">
			<header class="tm-appbar">
				<div class="tm-appbar-row">
					<div class="tm-brand">
						<span class="tm-brand-logo" aria-hidden="true">🧭</span>
						<div class="tm-brand-text">
							<div class="tm-brand-title">${__('Travel Manager')}</div>
							<div class="tm-brand-sub">Trips · Packages · Dates · Bookings · Customers</div>
						</div>
					</div>
					<div class="tm-appbar-actions">
						<button type="button" class="tm-appbar-btn tm-menu-btn"
							title="Menu" aria-label="Open navigation menu" aria-expanded="false">
							<span aria-hidden="true">☰</span>
						</button>
						<button type="button" class="tm-appbar-btn tm-refresh"
							title="Reload" aria-label="Reload">
							<span aria-hidden="true">⟳</span>
							<span class="tm-appbar-btn-label">Reload</span>
						</button>
					</div>
				</div>
				<nav class="tm-tabs" aria-label="${__('Travel Manager sections')}">
					<div class="tm-nav-items"></div>
				</nav>
				<nav class="tm-menu" aria-label="${__('Travel Manager sections')}"></nav>
				<div class="tm-menu-backdrop" aria-hidden="true"></div>
			</header>
		</div>
	`;

	// Content lives in .layout-main-section (the custom-page mount convention
	// — same as manage-booking-app), no longer inside .page-head.
	$(wrapper).find('.layout-main-section').html(`
		<nav><ol class="breadcrumb tm-bc mb-0 bg-white"></ol></nav>
		<div class="tm-body"></div>
	`);

	window.TravelManager = (function () {
		const $body = $(wrapper).find('.tm-body');

		// ── STANDARD PRAKTIS (Nov 2026): setiap DIV anak terus body kad
		// (.card-body Bootstrap) WAJIB ber-ID & ber-class — margin praktis
		// my-2 (utiliti stok) diberi kepada div kosong identiti.
		// MutationObserver menjamin ia pada SEMUA halaman & render akan
		// datang tanpa perlu ingat secara manual.
		const tagPanelBodyDivs = () => {
			wrapper.querySelectorAll('.card-body').forEach((body, bi) => {
				Array.from(body.children).forEach((child, ci) => {
					if (child.tagName !== 'DIV') return;
					if (!child.id) child.id = `tm-blk-${bi}-${ci}`;
					if (!child.className) child.className = 'my-2';
				});
			});
		};
		if (wrapper) {
			new MutationObserver(tagPanelBodyDivs)
				.observe(wrapper, { childList: true, subtree: true });
			tagPanelBodyDivs();
		}
		const $bc = $(wrapper).find('.tm-bc');
		const $navItems = $(wrapper).find('.tm-nav-items');
		const $menu = $(wrapper).find('.tm-menu');
		const $menuBtn = $(wrapper).find('.tm-menu-btn');
		const $menuBackdrop = $(wrapper).find('.tm-menu-backdrop');
		// ── Navigasi footer kad TRIP INFORMATION (DELEGATED — sekali sahaja
		// di shell, kekal hidup selepas setiap $body.html() render; footer
		// Details | Website | Sales terbina dalam tripInfoCardHtml).
		$body.on('click', '.tm-dir-detail', function () {
			frappe.set_route('travel-manager', 'trip', $(this).data('trip'));
		});
		$body.on('click', '.tm-dir-website', function () {
			frappe.set_route('travel-manager', 'trip', $(this).data('trip'), 'website');
		});
		$body.on('click', '.tm-dir-sales', function () {
			frappe.set_route('travel-manager', 'trip', $(this).data('trip'), 'sales');
		});

		const isManager = frappe.user.has_role('Tour Manager') || frappe.user.has_role('System Manager');

		// ══ SUB-PAKEJ HELPER KONGSI ══
		{% include "travel_booking/module_admin_portal/page/travel_manager/tm_shared.js" %}

		// [Nov 2026] NAV ber-anak: Trip jadi INDUK sub-menu — Cruise
		// Schedule dipindah bawah Trip + Trip Addon baharu (arahan pemilik).
		// Tab induk kekal navigasi ke route sendiri; caret ▾ buka dropdown
		// sub-menu (desktop) / anak terindent dalam panel ☰ (telefon).
		const NAV = [
			{ key: 'trip', route: 'trip', icon: '🗺️',
				label: 'Trip', desc: 'Trip list + directory',
				children: [
					{ key: 'cruise-schedule', route: 'cruise-schedule', icon: '🚢',
						label: 'Cruise Schedule', desc: 'Sailing schedules & cabin rates' },
					{ key: 'trip-addon', route: 'trip-addon', icon: '🎁',
						label: 'Trip Addon', desc: 'Upsell addons & packages' },
					{ key: 'travel-dates', route: 'travel-dates', icon: '📅',
						label: 'Travel Dates',
						desc: 'All date groups across trips — bulk manage & monitor' },
					{ key: 'package-offers', route: 'package-offers', icon: '📦',
						label: 'Package Offers',
						desc: 'All offers across trips — bulk manage & monitor' },
				] },
			{ key: 'booking', route: 'booking', icon: '👥',
				label: 'Booking',
				desc: 'All bookings — flat list, newest first',
				// [Nov 2026] Sub-menu Booking: Booking Group
				// (view penuh kumpulan booking — dipindah daripada route
				// 'booking'), Addon Booking (senarai flat semua order addon)
				// & Traveller (direktori profil doctype Traveller).
				children: [
					{ key: 'booking-group', route: 'booking-group', icon: '🗂️',
						label: 'Booking Group',
						desc: 'Groups · bookings · travellers · rooms — full booking manager' },
					{ key: 'addon-booking', route: 'addon-booking', icon: '🎁',
						label: 'Addon Booking',
						desc: 'All add-on orders across trips — flat list, newest first' },
					{ key: 'traveller', route: 'traveller', icon: '🧳',
						label: 'Traveller',
						desc: 'All traveller profiles — docs, contacts, bookings' },
				] },
			// [Nov 2026] Direktori customer — urus customer tanpa borang
			// doctype: contacts/address, tunggakan & credit note, bookings,
			// loyalty (bila aktif) + permukaan B2B Partner.
			{ key: 'customer', route: 'customer', icon: '👤',
				label: 'Customer',
				desc: 'All customers — contacts, balances, bookings, B2B' },
		];
		// Cari item nav (induk ATAU anak) ikut key — klik handler kongsi.
		const navByKey = (key) => {
			for (const n of NAV) {
				if (n.key === key) return n;
				const c = (n.children || []).find((x) => x.key === key);
				if (c) return c;
			}
			return null;
		};

		// Sub-path LAMA di bawah 'booking' — bukan nama booking; dialihkan
		// ke 'booking-group/<sub>' (view penuh tinggal di sana). Nama booking
		// (BK…) tidak pernah bertembung dengan kata-kata ini.
		const BOOKING_LIST_LEGACY_SUBS = ['batch', 'group', 'rooming', 'new'];

		const state = {
			view: 'trip',  // trip (list) | trip (directory) | travel-date | booking
			trip: null,
			date: null,    // Travel Date name (hierarki ERD: Trip >> Travel Date >> Packages)
			search: '', bkg_search: '', bkg_status: 'All',
		};
		let _bcRoutes = [];  // routes breadcrumb (closure — fix JSON double-parse)

		function set_menu(open) {
			$menu.toggleClass('open', open);
			$menuBackdrop.toggleClass('open', open);
			$menuBtn.attr('aria-expanded', open ? 'true' : 'false');
		}

		function render_nav() {
			// Aktif induk = key sendiri ATAU mana-mana key anak sedang aktif
			// (sub-menu Trip: cruise-schedule / trip-addon).
			const isActive = (n) => !n.external
				&& (state.view === n.key
					|| (n.children || []).some((c) => c.key === state.view));
			// Tutup semua dropdown sub-menu terbuka.
			const close_subs = () => {
				$navItems.find('.tm-nav-sub').removeClass('open');
				$navItems.find('.tm-nav-caret').attr('aria-expanded', 'false');
			};
			// Top tabs (desktop ≥768px) — pills inside the gradient app bar;
			// item ber-anak dapat caret ▾ + dropdown .tm-nav-sub.
			$navItems.html(NAV.map((n) => {
				const btn = `
					<button type="button" class="tm-nav-item ${isActive(n) ? 'tm-nav-active' : ''}"
						data-key="${n.key}">
						<span class="tm-nav-icon" aria-hidden="true">${n.icon}</span>
						<span>${esc(n.label)}</span>
					</button>`;
				if (!n.children) return btn;
				return `
					<div class="tm-nav-group">
						${btn}
						<button type="button" class="tm-nav-caret" data-key="${n.key}"
							aria-haspopup="true" aria-expanded="false"
							title="Sub-menu ${esc(n.label)}">
							<span aria-hidden="true">▾</span>
						</button>
						<div class="tm-nav-sub" role="menu" aria-label="${esc(n.label)} sub-menu">
							${n.children.map((c) => `
								<button type="button" role="menuitem"
									class="tm-nav-sub-item ${state.view === c.key ? 'tm-nav-active' : ''}"
									data-key="${c.key}">
									<span class="tm-nav-icon" aria-hidden="true">${c.icon}</span>
									<span>${esc(c.label)}</span>
								</button>`).join('')}
						</div>
					</div>`;
			}).join(''));
			// Menu panel (phone <768px) — opened by the ☰ app bar button;
			// anak sub-menu terindent dalam .tm-menu-sub di bawah induk.
			$menu.html(NAV.map((n) => {
				const item = `
					<button type="button" class="tm-menu-item ${isActive(n) ? 'tm-nav-active' : ''}"
						data-key="${n.key}">
						<span class="tm-menu-icon" aria-hidden="true">${n.icon}</span>
						<span>
							<div class="tm-menu-label">${esc(n.label)}</div>
							<div class="tm-menu-desc">${esc(n.desc)}</div>
						</span>
					</button>`;
				if (!n.children) return item;
				return item + `
					<div class="tm-menu-sub">
						${n.children.map((c) => `
							<button type="button"
								class="tm-menu-item tm-menu-sub-item ${state.view === c.key ? 'tm-nav-active' : ''}"
								data-key="${c.key}">
								<span class="tm-menu-icon" aria-hidden="true">${c.icon}</span>
								<span>
									<div class="tm-menu-label">${esc(c.label)}</div>
									<div class="tm-menu-desc">${esc(c.desc)}</div>
								</span>
							</button>`).join('')}
					</div>`;
			}).join(''));
			// One shared click handler for both bars; menu + dropdowns
			// close on navigate.
			[$navItems, $menu].forEach(($bar) => {
				$bar.find('button').on('click', function () {
					const $b = $(this);
					// Caret ▾ = toggle dropdown sub-menu (BUKAN navigasi).
					if ($b.hasClass('tm-nav-caret')) {
						const $sub = $b.siblings('.tm-nav-sub');
						const open = !$sub.hasClass('open');
						close_subs();
						$sub.toggleClass('open', open);
						$b.attr('aria-expanded', open ? 'true' : 'false');
						return;
					}
					const item = navByKey($b.data('key'));
					close_subs();
					set_menu(false);
					if (!item) return;
					if (item.external) {
						frappe.set_route(item.route);  // existing Booking Group app
						return;
					}
					frappe.set_route('travel-manager', item.route);
				});
			});
		}

		$menuBtn.on('click', () => set_menu(!$menu.hasClass('open')));
		$menuBackdrop.on('click', () => set_menu(false));
		$(document).on('click', (e) => {
			// Klik LUAR kumpulan nav (dropdown sub-menu) → tutup dropdown.
			if (!$(e.target).closest('.tm-nav-group').length) {
				$navItems.find('.tm-nav-sub').removeClass('open');
				$navItems.find('.tm-nav-caret').attr('aria-expanded', 'false');
			}
		});
		$(document).on('keydown', (e) => {
			if (e.key === 'Escape') set_menu(false);
		});

		function breadcrumb(segments) {
			// segments: [{label, route?: [..]}] — the last one has NO link (current).
			// FIX (Nov 2026): route TIDAK disimpan sebagai JSON dalam data-
			// attribute — jQuery .data() auto-parse JSON attribute kepada
			// array, lalu JSON.parse() lama atas array itu meletup
			// (SyntaxError "travel-manag... is not valid JSON"). Routes
			// disimpan dalam closure array; link hanya bawa indeks.
			_bcRoutes = segments.map((s) => s.route || null);
			// Komponen stok .breadcrumb Bootstrap — pemisah datang daripada
			// CSS .breadcrumb-item + .breadcrumb-item::before (tiada span ›).
			$bc.html(segments.map((s, i) => {
				const isLast = i === segments.length - 1;
				const inner = isLast || !s.route
					? `<strong>${esc(s.label)}</strong>`
					: `<a href="javascript:void(0)" class="tm-bc-link" data-bc-idx="${i}">${esc(s.label)}</a>`;
				return `<li class="breadcrumb-item${isLast ? ' active' : ''}">${inner}</li>`;
			}).join(''));
			$bc.find('.tm-bc-link').off('click').on('click', function () {
				const route = _bcRoutes[$(this).data('bc-idx')];
				if (route && route.length) frappe.set_route(...route);
			});
		}

		// ── BOOKING ORDER VIEW — HOST DIREKTORI (Nov 2026) ──
		// Page SATU booking order (tm_booking_view.js) ialah komponen BEBAS:
		// mana-mana seksyen boleh membukanya dan view KEKAL dalam direktori
		// seksyen itu (crumb, butang kembali & Prev/Next ikut senarai asal).
		// Setiap cabang route yang berakhir dengan nama booking memanggil
		// helper ini dengan:
		//   crumbs — crumb INDUK sehingga direktori pemanggil (crumb nama
		//            booking ditambah di sini)
		//   ctx    — konteks direktori {dir, back, route_for, nav} yang
		//            dibina oleh seksyen pemanggil
		// Seksyen baharu yang nak membuka page booking order = satu cabang
		// route (nama booking sebagai segmen terakhir) + satu fungsi ctx —
		// tiada perubahan pada view. Host sedia ada:
		//   booking/<BK>                      booking_list_dir_ctx (tm_booking_list.js)
		//   booking-group/[group/<G>|batch/<B>/]<BK>
		//                                     booking_group_dir_ctx (tm_booking.js)
		//   customer/<C>/<BK>                 customer_dir_ctx (tm_customer.js)
		function show_booking_order(name, crumbs, ctx) {
			if (!window.BookingManagement) return false;
			breadcrumb([...crumbs, { label: name }]);
			document.body.classList.add('tm-booking-active');
			window.BookingManagement.open_booking(name, ctx);
			return true;
		}

		function handle_route() {
			// Marker CSS view booking (body.tm-booking-active) — diset
			// semula setiap dispatch; branch 'booking' mengaktifkannya
			// semula (lihat bawah). CSS .mba-* global lama di-skop ke
			// class ini supaya view tm lain tak terjejas.
			document.body.classList.remove('tm-booking-active');
			// PARSER ROBUST (bukan indeks tetap): URL boleh muncul dengan
			// shell segment module di depan (cth /desk/module-admin-portal/
			// travel-manager/...) dan Frappe v17 membuangnya secara DINAMIK
			// (take_shell_from — bergantung boot/module_slugs yang sedia).
			// Indeks tetap route[3]/route[5] pecah bila shell hadir/hilang;
			// jadi parse ikut KATA KUNCI: 'trip' → <trip> ['new-trip' |
			// 'date' → <td> ['pkg' → <offer>]].
			const route = frappe.get_route() || [];
			const i = (kw) => route.indexOf(kw);
			const iTrip = i('trip');
			const iSales = i('sales');
			const iWeb = i('website');
			if (iTrip !== -1) {
				const trip = route[iTrip + 1] || null;
				const iDate = i('date');
				const iPkg = i('pkg');
				if (trip === 'new-trip') {
					state.view = 'trip';
					state.trip = null;
					render_nav();
					load_new_trip_wizard();
					return;
				}
				if (!trip) {
					state.view = 'trip';
					render_nav();
					load_trips();
					return;
				}
				state.view = 'trip';
				state.trip = trip;
				state.date = null;
				if (iDate !== -1 && route[iDate + 1]) {
					state.date = route[iDate + 1];
				}
				// [Nov 2026] TAB pakej = toggle DALAM SATU URL (arahan pemilik,
				// corak halaman tarikh): pkg/<offer> TANPA segmen view —
				// kandungan tab (info/itinerary/prices/addons/config) ditoggl
				// in-page; tiada pecahan directory URL per tab.
				render_nav();
				if (state.date && iPkg !== -1 && route[iPkg + 1]) {
					// Hierarki ERD: Trip >> Date >> Package (admin pakej).
					load_travel_package_admin(trip, state.date,
						route[iPkg + 1], route[iPkg + 1]);
				} else if (state.date) {
					load_travel_date(trip, state.date);
				} else if (iWeb !== -1) {
					// Sub-directory kandungan WEBSITE trip (Nov 2026) — urus
					// tab Website doctype Trip tanpa akses borang Trip.
					load_trip_website(trip);
				} else if (iSales !== -1) {
					// Sub-directory jualan trip (dipindah keluar dari
					// trip directory — Nov 2026).
					load_trip_sales(trip);
				} else {
					load_trip_directory(trip);
				}
				return;
			}
			// CRUISE SCHEDULE — senarai + detail (Nov 2026): urus Trip
			// Cruise Schedule tanpa akses borang doctype. Segmen selepas
			// kata kunci = NAMA schedule (kosong → senarai).
			const iCs = i('cruise-schedule');
			if (iCs !== -1) {
				state.view = 'cruise-schedule';
				state.trip = null;
				state.date = null;
				render_nav();
				const sched = route[iCs + 1] || null;
				if (sched) load_cruise_schedule_detail(sched);
				else load_cruise_schedules();
				return;
			}
			// TRIP ADDON — senarai + detail (sub-menu Trip, Nov 2026): urus
			// Trip Addon (produk) + Trip Addon Package (harga/scoping)
			// tanpa akses borang doctype. Segmen selepas kata kunci = NAMA
			// addon (kosong → senarai).
			const iTa = i('trip-addon');
			if (iTa !== -1) {
				state.view = 'trip-addon';
				state.trip = null;
				state.date = null;
				render_nav();
				const addon = route[iTa + 1] || null;
				if (addon) load_trip_addon_detail(addon);
				else load_trip_addons();
				return;
			}
			// TRAVEL DATES — direktori SEMUA Travel Date aras-trip (sub-menu
			// Trip, Nov 2026): pantau & urus semua kumpulan tarikh
			// beramai-ramai (carian, penapis, bulk edit/padam, update
			// segera). Tiada detail view sendiri — baris deep-link ke
			// halaman tarikh sedia ada (trip/<trip>/date/<date>).
			const iTdd = i('travel-dates');
			if (iTdd !== -1) {
				state.view = 'travel-dates';
				state.trip = null;
				state.date = null;
				render_nav();
				load_dates_directory();
				return;
			}
			// PACKAGE OFFERS — direktori SEMUA offer aras-trip (sub-menu
			// Trip, Nov 2026): pantau & urus beramai-ramai (carian, penapis,
			// bulk edit/padam, update segera). Tiada detail view sendiri —
			// baris deep-link ke halaman admin offer sedia ada
			// (trip/<trip>/date/<date>/pkg/<offer>).
			const iPo = i('package-offers');
			if (iPo !== -1) {
				state.view = 'package-offers';
				state.trip = null;
				state.date = null;
				render_nav();
				load_package_offers();
				return;
			}
			// CUSTOMER — direktori SEMUA customer (tab sendiri selepas
			// Booking, Nov 2026). Segmen selepas kata kunci =
			// NAMA customer (kosong → senarai; ada → detail — corak
			// cruise-schedule/trip-addon; router Frappe encode/decode
			// segmen automatik, nama ber-selang selamat).
			const iCu = i('customer');
			if (iCu !== -1) {
				state.view = 'customer';
				state.trip = null;
				state.date = null;
				render_nav();
				const cust = route[iCu + 1] || null;
				// PAGE BOOKING ORDER dalam DIREKTORI CUSTOMER
				// (customer/<C>/<BK>) — baris booking pada detail customer
				// dibuka tanpa meninggalkan customer itu: crumb kekal
				// Travel Manager › Customer › <C> › <BK>, butang kembali ke
				// customer & Prev/Next ikut booking customer tersebut.
				if (cust && route[iCu + 2]) {
					show_booking_order(route[iCu + 2], [
						{ label: 'Travel Manager', route: ['travel-manager'] },
						{ label: 'Customer', route: ['travel-manager', 'customer'] },
						{ label: cust, route: ['travel-manager', 'customer', cust] },
					], customer_dir_ctx(cust));
					return;
				}
				if (cust) load_customer_detail(cust);
				else load_customers();
				return;
			}
			// TRAVELLER — direktori SEMUA profil traveller (doctype
			// Traveller; sub-menu Booking, Nov 2026): datatable
			// carian server-side (nama/IC/pasport/emel/telefon), penapis
			// status/kewarganegaraan/kategori umur, agregat booking.
			const iTvd = i('traveller');
			if (iTvd !== -1) {
				state.view = 'traveller';
				state.trip = null;
				state.date = null;
				render_nav();
				breadcrumb([
					{ label: 'Travel Manager', route: ['travel-manager'] },
					{ label: 'Booking', route: ['travel-manager', 'booking'] },
					{ label: 'Traveller' },
				]);
				load_traveller_dir();
				return;
			}
			// ADDON BOOKING — senarai FLAT semua Booking Addon merentas trip
			// (sub-menu Booking selepas Booking Group, Nov 2026):
			// carian server-side, penapis status/payment/currency, jumlah
			// nilai per currency. Klik Booking No → Booking Info (L3).
			const iAbk = i('addon-booking');
			if (iAbk !== -1) {
				state.view = 'addon-booking';
				state.trip = null;
				state.date = null;
				render_nav();
				breadcrumb([
					{ label: 'Travel Manager', route: ['travel-manager'] },
					{ label: 'Booking', route: ['travel-manager', 'booking'] },
					{ label: 'Addon Booking' },
				]);
				load_addon_booking_list();
				return;
			}
			// BOOKING GROUP — sub-menu di bawah Booking (Nov 2026):
			// view penuh kumpulan booking DIPINDAH daripada route 'booking'.
			// Kata kunci 'booking-group':
			//   booking-group                     → senarai group/batch (L1)
			//   booking-group/batch/<B|group/<G>  → detail (L2)
			//   booking-group/<BK...>             → booking info (L3)
			//   booking-group/group/<G>/<BK>      → booking info (L3) DALAM
			//                                       direktori group (Nov 2026)
			//   booking-group/batch/<B>/<BK>      → booking info (L3) DALAM
			//                                       direktori batch (Nov 2026)
			//   booking-group/rooming/<kind>/<id> → Rooming Board
			//   booking-group/new                 → wizard booking baru
			// Legacy 'booking-management' (URL lama) dialih ke route ini —
			// kandungannya kini tinggal di sini.
			if (route.includes('booking-management')) {
				frappe.set_route('travel-manager', 'booking-group');
				return;
			}
			const iBg = i('booking-group');
			if (iBg !== -1) {
				state.view = 'booking-group';
				render_nav();
				const seg = route.slice(iBg + 1);
				const bc = [
					{ label: 'Travel Manager', route: ['travel-manager'] },
					{ label: 'Booking', route: ['travel-manager', 'booking'] },
					{ label: 'Booking Group', route: ['travel-manager', 'booking-group'] },
				];
				// WIZARD BOOKING BARU (Nov 2026) — segmen 'new' BUKAN nama
				// booking; embed() akan mentafsir 'new' sebagai booking
				// "new" jika tidak ditapis di sini (corak 'new-trip' di atas).
				if (seg[0] === 'new') {
					bc.push({ label: 'Booking Baru' });
					breadcrumb(bc);
					document.body.classList.add('tm-booking-active');
					load_booking_wizard();
					return;
				}
				// PAGE BOOKING ORDER (L3) — dibuka DALAM direktori Booking
				// Group dan kekal di bawah induknya (root / group / batch):
				// crumb induk kekal boleh klik, Prev/Next ikut senarai
				// induk itu (konteks: booking_group_dir_ctx di tm_booking.js).
				const isParent = (s) => s === 'batch' || s === 'group';
				const bkgLeaf = (isParent(seg[0]) && seg[1]) ? seg[2]
					: (seg[0] && !['batch', 'group', 'rooming'].includes(seg[0]) ? seg[0] : null);
				if (bkgLeaf && window.BookingManagement) {
					if (isParent(seg[0])) {
						bc.push({ label: seg[1], route: ['travel-manager', 'booking-group', seg[0], seg[1]] });
					}
					if (show_booking_order(bkgLeaf, bc,
						window.BookingManagement.booking_group_dir_ctx(seg))) return;
				}
				if (seg[0] === 'rooming' && seg[1]) bc.push({ label: 'Rooming Board' });
				else if (seg[0] && seg[1]) bc.push({ label: seg[1] });
				else if (seg[0]) bc.push({ label: seg[0] });
				breadcrumb(bc);
				document.body.classList.add('tm-booking-active');
				window.BookingManagement.embed(seg);
				return;
			}
			// BOOKING MANAGEMENT — senarai FLAT semua booking (Nov 2026,
			// menggantikan view penuh yang dipindah ke 'booking-group'):
			// satu baris setiap booking merentas SEMUA trip, created on
			// TERKINI dahulu (creation DESC), TANPA melalui travel date —
			// carian, penapis dinamik, bulk edit & download melalui komponen
			// generik TravelBookingBookingList (all_scope).
			const iBk = i('booking');
			if (iBk !== -1) {
				const segBk = route.slice(iBk + 1);
				// PAGE BOOKING ORDER (booking/<BK>) — DIBUKA DALAM DIREKTORI
				// SENARAI INI (Nov 2026): crumb kekal Travel Manager › Booking
				// › <BK>, butang kembali ke senarai flat dan Prev/Next ikut
				// susunan + tapisan senarai yang sedang dilihat (konteks:
				// booking_list_dir_ctx di tm_booking_list.js). Sebelum ini
				// semua sub-path dilompatkan ke 'booking-group' — pengguna
				// hilang direktori asal.
				if (segBk.length === 1 && !BOOKING_LIST_LEGACY_SUBS.includes(segBk[0])) {
					state.view = 'booking';
					state.trip = null;
					state.date = null;
					render_nav();
					if (show_booking_order(segBk[0], [
						{ label: 'Travel Manager', route: ['travel-manager'] },
						{ label: 'Booking', route: ['travel-manager', 'booking'] },
					], booking_list_dir_ctx())) return;
				}
				// URL lama 'booking/<sub>' (batch/group/<BK>/rooming/new) —
				// view penuh tinggal di 'booking-group'.
				if (segBk.length) {
					frappe.set_route('travel-manager', 'booking-group', ...segBk);
					return;
				}
				state.view = 'booking';
				render_nav();
				breadcrumb([
					{ label: 'Travel Manager', route: ['travel-manager'] },
					{ label: 'Booking' },
				]);
				document.body.classList.add('tm-booking-active');
				load_booking_list();
				return;
			}
			// Lalai: senarai trip (termasuk legacy 'trip-management').
			state.view = 'trip';
			render_nav();
			load_trips();
		}

		function refresh() {
			handle_route();
		}
		$(wrapper).find('.tm-refresh').on('click', refresh);

		// ══ SEKSYEN: TRIP LIST ══
		{% include "travel_booking/module_admin_portal/page/travel_manager/tm_trip_list.js" %}

		// ══ SEKSYEN: CRUISE SCHEDULE ══
		{% include "travel_booking/module_admin_portal/page/travel_manager/tm_cruise_schedule.js" %}

		// ══ SEKSYEN: TRIP ADDON ══
		{% include "travel_booking/module_admin_portal/page/travel_manager/tm_trip_addon.js" %}

		// ══ SEKSYEN: PACKAGE OFFERS (direktori aras-trip) ══
		{% include "travel_booking/module_admin_portal/page/travel_manager/tm_package_offers.js" %}

		// ══ SEKSYEN: BOOKING MANAGEMENT (view penuh — dipindah daripada
		// page berasingan travel_management/booking_management, Nov 2026;
		// route 'booking' → DIPINDAH ke sub-menu 'booking-group', Nov 2026).
		// IIFE tersendiri: window.BookingManagement.embed(segments).
		// View lama tm_booking_mgmt.js dikekalkan di disk, TIDAK di-include.
		{% include "travel_booking/module_admin_portal/page/travel_manager/tm_booking.js" %}

		// ══ SEKSYEN: BOOKING LIST (route 'booking' — senarai FLAT semua
		// booking, created on terkini dahulu, Nov 2026) — komponen generik
		// TravelBookingBookingList (all_scope).
		{% include "travel_booking/module_admin_portal/page/travel_manager/tm_booking_list.js" %}

		// ══ SEKSYEN: TRAVELLER DIREKTORI (route 'traveller' — sub-menu
		// Booking, Nov 2026) — direktori semua profil doctype
		// Traveller; API travel_booking.api.traveller_admin (helper tva).
		{% include "travel_booking/module_admin_portal/page/travel_manager/tm_traveller_dir.js" %}

		// ══ SEKSYEN: ADDON BOOKING (route 'addon-booking' — sub-menu
		// Booking selepas Booking Group, Nov 2026) — senarai
		// flat semua Booking Addon; API get_all_addons (helper mtb).
		{% include "travel_booking/module_admin_portal/page/travel_manager/tm_addon_booking.js" %}

		// ══ SEKSYEN: CUSTOMER DIREKTORI (tab sendiri selepas Booking
		// Management, Nov 2026) — direktori semua customer + detail;
		// API travel_booking.api.customer_admin (helper cst kongsi).
		{% include "travel_booking/module_admin_portal/page/travel_manager/tm_customer.js" %}

		// ══ SEKSYEN: BOOKING WIZARD (route booking/new — cipta booking desk) ══
		{% include "travel_booking/module_admin_portal/page/travel_manager/tm_booking_wizard.js" %}

		// ══ SEKSYEN: TRAVEL DATE & PACKAGE ADMIN ══
		{% include "travel_booking/module_admin_portal/page/travel_manager/tm_package_admin.js" %}

		// ══ SEKSYEN: DATE DIRECTORY ══
		{% include "travel_booking/module_admin_portal/page/travel_manager/tm_travel_date.js" %}

		// ══ SEKSYEN: TRAVEL DATES DIREKTORI (semua tarikh aras-trip) ══
		{% include "travel_booking/module_admin_portal/page/travel_manager/tm_dates_directory.js" %}

		// ══ SEKSYEN: TRIP DIRECTORY ══
		{% include "travel_booking/module_admin_portal/page/travel_manager/tm_trip_directory.js" %}

		// ══ SEKSYEN: TRIP SALES ══
		{% include "travel_booking/module_admin_portal/page/travel_manager/tm_trip_sales.js" %}

		// ══ SEKSYEN: TRIP WEBSITE ══
		{% include "travel_booking/module_admin_portal/page/travel_manager/tm_trip_website.js" %}

		// ══ SEKSYEN: NEW TRIP WIZARD ══
		{% include "travel_booking/module_admin_portal/page/travel_manager/tm_new_trip_wizard.js" %}

	return { refresh, handle_route };
	})();

	TravelManager.handle_route();

	// Sub-view navigation (Trip → Travel Date → back) mengubah hash route
	// DALAM page yang sama — on_page_show hanya jalan sekali semasa dibuka.
	// Dengar router change (corak trip_command_center). 'travel-manager'
	// boleh di route[0] ATAU route[1] (shell segment module di depan URL).
	frappe.router.on('change', function () {
		const route = frappe.get_route() || [];
		if (route.includes('travel-manager')) {
			window.TravelManager.handle_route();
		}
	});
};

frappe.pages['travel-manager'].on_page_show = function () {
	if (window.TravelManager) window.TravelManager.handle_route();
};
