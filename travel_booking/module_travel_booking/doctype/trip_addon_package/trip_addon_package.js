// Copyright (c) 2026, WargaPrihatin and contributors
// For license information, please see license.txt

// Child table Trip Scoping — FILTER DEPENDENT berantai:
//   trip → group_date (filter ikut trip yang dipilih)
//        → trip_package (filter ikut group date yang dipilih; fallback ikut trip)
//
// Tanpa ni, dropdown group date / package memaparkan SEMUA rekod merentasi
// trip — user boleh pilih kombinasi yang tak konsisten (cth group date
// trip lain daripada trip yang dipilih dalam row yang sama).

frappe.ui.form.on("Trip Addon Package", {
	setup(frm) {
		// Group Date: hanya TGD Active bagi trip yang dipilih dalam row.
		frm.set_query("group_date", "trip_scoping", function (doc, cdt, cdn) {
			const row = locals[cdt][cdn];
			const filters = { status: "Active" };
			if (row.trip) filters.trip = row.trip;
			return { filters: filters };
		});

		// Trip Package: hubungan Package↔Group Date many-to-many (child
		// table) — link filter biasa tak boleh; guna query custom. Kalau
		// group date belum dipilih tapi trip ada → fallback senarai pakej
		// trip tersebut.
		frm.set_query("trip_package", "trip_scoping", function (doc, cdt, cdn) {
			const row = locals[cdt][cdn];
			if (row.group_date) {
				return {
					query:
						"travel_booking.api.addon_manager.search_trip_packages_by_group_date",
					filters: { group_date: row.group_date, trip: row.trip },
				};
			}
			if (row.trip) {
				return { filters: { trip_link: row.trip, status: "Active" } };
			}
			return { filters: { status: "Active" } };
		});
	},
});

frappe.ui.form.on("Trip Scoping", {
	trip(frm, cdt, cdn) {
		// Trip bertukar → padan group date & package lama row ni (stale).
		const row = locals[cdt][cdn];
		if (row.group_date || row.group_date_name) {
			frappe.model.set_value(cdt, cdn, "group_date", "");
			frappe.model.set_value(cdt, cdn, "group_date_name", "");
		}
		if (row.trip_package || row.package_title) {
			frappe.model.set_value(cdt, cdn, "trip_package", "");
			frappe.model.set_value(cdt, cdn, "package_title", "");
		}
	},

	group_date(frm, cdt, cdn) {
		const row = locals[cdt][cdn];
		// Group date bertukar → pakej lama (mungkin untuk tarikh lain) dibuang.
		if (row.trip_package || row.package_title) {
			frappe.model.set_value(cdt, cdn, "trip_package", "");
			frappe.model.set_value(cdt, cdn, "package_title", "");
		}
		// Auto-isi trip kalau masih kosong — TGD tahu trip dia; elak user
		// perlu pilih semula (dan elak row trip kosong + group date terisi).
		if (row.group_date && !row.trip) {
			frappe.db
				.get_value("Trip Group Date", row.group_date, "trip")
				.then((r) => {
					if (r && r.message && r.message.trip) {
						frappe.model.set_value(cdt, cdn, "trip", r.message.trip);
					}
				});
		}
	},
});
