// Copyright (c) 2026, WargaPrihatin and contributors
// For license information, please see license.txt

// Child table Trip Scoping — FILTER DEPENDENT berantai (RECONDITION
// Nov 2026: Trip Group Date → Travel Date, Trip Package → Package Offer):
//   trip → travel_date (filter ikut trip yang dipilih)
//        → package_offer (filter ikut travel date yang dipilih; fallback
//          ikut trip)
//
// Tanpa ni, dropdown travel date / offer memaparkan SEMUA rekod merentasi
// trip — user boleh pilih kombinasi yang tak konsisten (cth travel date
// trip lain daripada trip yang dipilih dalam row yang sama).

frappe.ui.form.on("Trip Addon Package", {
	setup(frm) {
		// Travel Date: hanya TD Active (status_editorial) bagi trip yang
		// dipilih dalam row.
		frm.set_query("travel_date", "trip_scoping", function (doc, cdt, cdn) {
			const row = locals[cdt][cdn];
			const filters = { status_editorial: "Active" };
			if (row.trip) filters.trip = row.trip;
			return { filters: filters };
		});

		// Package Offer: offer dipaut terus kepada travel date (field
		// travel_date) — query custom menapis offer ikut TD/trip row.
		// Kalau travel date belum dipilih tapi trip ada → fallback senarai
		// offer trip tersebut.
		frm.set_query("package_offer", "trip_scoping", function (doc, cdt, cdn) {
			const row = locals[cdt][cdn];
			return {
				query:
					"travel_booking.api.addon_manager.search_package_offers_by_travel_date",
				filters: { travel_date: row.travel_date || "", trip: row.trip || "" },
			};
		});
	},
});

frappe.ui.form.on("Trip Scoping", {
	trip(frm, cdt, cdn) {
		// Trip bertukar → padam travel date & offer lama row ni (stale).
		const row = locals[cdt][cdn];
		if (row.travel_date || row.travel_date_name) {
			frappe.model.set_value(cdt, cdn, "travel_date", "");
			frappe.model.set_value(cdt, cdn, "travel_date_name", "");
		}
		if (row.package_offer || row.offer_name) {
			frappe.model.set_value(cdt, cdn, "package_offer", "");
			frappe.model.set_value(cdt, cdn, "offer_name", "");
		}
	},

	travel_date(frm, cdt, cdn) {
		const row = locals[cdt][cdn];
		// Travel date bertukar → offer lama (untuk tarikh lain) dibuang.
		if (row.package_offer || row.offer_name) {
			frappe.model.set_value(cdt, cdn, "package_offer", "");
			frappe.model.set_value(cdt, cdn, "offer_name", "");
		}
		// Auto-isi trip kalau masih kosong — Travel Date tahu trip dia; elak
		// user perlu pilih semula (dan elak row trip kosong + TD terisi).
		if (row.travel_date && !row.trip) {
			frappe.db
				.get_value("Travel Date", row.travel_date, "trip")
				.then((r) => {
					if (r && r.message && r.message.trip) {
						frappe.model.set_value(cdt, cdn, "trip", r.message.trip);
					}
				});
		}
	},
});
