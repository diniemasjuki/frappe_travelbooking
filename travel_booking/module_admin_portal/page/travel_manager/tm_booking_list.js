// travel_booking/module_admin_portal/page/travel_manager/tm_booking_list.js
// BOOKING MANAGEMENT — SENARAI FLAT SEMUA BOOKING (route 'booking')
//
// [Nov 2026] Route 'booking' DIGANTI — view penuh kumpulan booking
// (group/batch → detail → booking info → rooming → wizard) DIPINDAH ke
// sub-menu 'booking-group' (tm_booking.js). Route ini kini senarai FLAT
// semua booking MERENTAS trip — TANPA melalui travel date — satu baris
// setiap booking, disusun created on TERKINI dahulu (creation DESC,
// server-side; API get_all_bookings).
//
// Konsep interface SAMA dengan page booking-group: komponen generik
// window.TravelBookingBookingList (public/js/booking_list.js) yang sama
// dengan tab Booking L2 — carian server-side (booking/customer/traveller/
// trip), panel penapis dinamik (medan Booking/Customer), penapis status &
// payment, bulk edit/delete, muat turun XLSX/CSV (skop semua booking),
// Order By, Load more; kad responsif pada telefon, jadual penuh ≥992px.
// Klik baris/kad → Booking Info (L3) di route booking/<BK> — DIBUKA
// DALAM DIREKTORI SENARAI INI (Nov 2026; dahulunya dilompatkan ke
// booking-group/<BK>): crumb kekal Travel Manager › Booking › <BK>,
// butang kembali ke senarai ini & Prev/Next ikut susunan + tapisan
// senarai yang sedang dilihat (booking_list_dir_ctx di bawah).
//
// Di-include ke dalam scope IIFE page oleh render_include (concatenation)
// — kongsi closure $body/breadcrumb/esc dengan fail seksyen lain.

/* ══════════════════════════════════════════════════════════════════════
   SEKSYEN: BOOKING LIST — SENARAI FLAT (tm_booking_list.js)
   ══════════════════════════════════════════════════════════════════════ */

// State view — kekal merentas re-entry route (corak S BookingManagement).
const BKL = {
	inst: null,          // instance komponen aktif
	state: {},           // { search, status, payment, currency, limit, custom[], ... }
};

// KONTEKS DIREKTORI senarai flat untuk page booking order
// (tm_booking_view.js) — dipanggil shell (show_booking_order) setiap kali
// route booking/<BK> dipapar:
//   back       — butang kembali ke senarai ini
//   route_for  — laluan Next/Prev kekal dalam direktori ini
//   nav        — skop Prev/Next = KEADAAN SENARAI INI:
//     • tiada sort klien → server (get_booking_neighbours) guna tapisan
//       yang SAMA (inst.filter_args = argumen yang dihantar komponen ke
//       server) & turutan server, tanpa had baris — merentasi "Load more";
//     • ada sort klien → turutan PAPARAN (baris yang dimuat) dihantar
//       terus supaya jiran tepat ikut apa yang dilihat user.
// Selepas reload pelayar (senarai belum dimuat) → tiada tapisan: direktori
// lalai (semua booking, terkini dahulu).
function booking_list_dir_ctx() {
	const inst = BKL.inst;
	const ctx = {
		dir: 'booking',
		back: { label: 'All Bookings', route: ['travel-manager', 'booking'] },
		route_for: (name) => ['travel-manager', 'booking', name],
		nav: { scope: 'all', filters: inst ? inst.filter_args() : null, names: null },
	};
	if (inst && BKL.state && BKL.state.sort) ctx.nav.names = inst.ordered_names();
	return ctx;
}

// Layout — baris aksi (+ Booking Baru → wizard booking-group/new)
// + kontena komponen. Idempoten; $body dijana semula setiap kali
// view lain aktif.
function ensure_booking_list_layout() {
	if ($body.find('#tm-bkl-root').length) return;
	$body.html(`
		<div class="tm-bkl">
			<div class="d-flex align-items-center justify-content-end my-2">
				<button type="button" class="btn btn-primary btn-sm tm-bkl-new-booking"
					title="${esc(__('Cipta booking baru bagi pihak pelanggan (wizard desk)'))}">
					+ ${__('Booking Baru')}
				</button>
			</div>
			<div id="tm-bkl-root"></div>
		</div>`);
}

// Butang Booking Baru — delegasi pada $body (kekal hidup selepas
// setiap render view).
$body.on('click', '.tm-bkl-new-booking', () => {
	frappe.set_route('travel-manager', 'booking-group', 'new');
});

// Dipanggil shell handle_route() untuk kata kunci 'booking'.
function load_booking_list() {
	ensure_booking_list_layout();
	if (!window.TravelBookingBookingList) {
		$body.find('#tm-bkl-root').html(
			`<div class="mba-empty">${__('Booking list component not loaded.')}</div>`);
		return;
	}
	// Re-entry — instance lama dibina semula bila DOM view telah
	// diganti view lain (is_attached()); state penapis kekal.
	if (!BKL.inst || !BKL.inst.is_attached()) {
		BKL.inst = window.TravelBookingBookingList.create($('#tm-bkl-root'), {
			// SENARAI FLAT — semua booking tanpa skop group date;
			// API get_all_bookings, creation DESC (terkini dahulu).
			all_scope: true,
			state: BKL.state,
			title: '📋 ' + __('All Bookings'),
			show_title: true,
			show_summary: true,
			show_cards: true,
			columns: 'full',
			// Currency paparan lalai — sysdefault (fallback MYR);
			// pecahan per-currency kekal sumber kebenaran.
			currency: (frappe.boot && frappe.boot.sysdefaults && frappe.boot.sysdefaults.currency) || 'MYR',
			currency_filter: true,
			search_placeholder: __('Search booking / customer / traveller / trip...'),
			// Klik baris/kad/kolum Booking No → page Booking Order (L3)
			// DALAM direktori senarai ini (booking/<BK>).
			on_open_booking: (name) => frappe.set_route('travel-manager', 'booking', name),
		});
	}
	if (BKL.inst) {
		// Sentiasa fetch semula — status payment/invois berubah cepat
		// (corak show_list BookingManagement: balik ke senarai = refresh).
		BKL.inst.load(true);
	}
}
