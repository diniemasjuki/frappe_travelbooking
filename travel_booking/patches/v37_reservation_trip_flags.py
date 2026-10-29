import frappe


def execute():
	"""Backfill penanda klasifikasi trip Booking Reservation:

	- birthday_on_trip           — ulang tahun (bulan-hari) DOB traveller
	                               dalam tempoh departure–return.
	- passport_to_expire_on_trip — passport luput < 6 bulan dari departure.

	Penanda dikira oleh BookingReservation.compute_trip_flags() (auto pada
	setiap save reservation / Traveller selepas ni); patch ni hanya mengisi
	rekod sedia ada SEKALI selepas kolum baharu dicipta oleh migrate.
	"""
	names = frappe.get_all("Booking Reservation", pluck="name")
	changed = 0
	for name in names:
		try:
			doc = frappe.get_doc("Booking Reservation", name)
			# compute_trip_flags() menimpa field pada instance — nilai lama
			# disimpan dulu untuk banding (rekod lama semua default 0).
			old_b = doc.birthday_on_trip or 0
			old_p = doc.passport_to_expire_on_trip or 0
			doc.compute_trip_flags()
			updates = {}
			if (doc.birthday_on_trip or 0) != old_b:
				updates["birthday_on_trip"] = doc.birthday_on_trip
			if (doc.passport_to_expire_on_trip or 0) != old_p:
				updates["passport_to_expire_on_trip"] = doc.passport_to_expire_on_trip
			if updates:
				frappe.db.set_value("Booking Reservation", name,
					updates, update_modified=False)
				changed += 1
		except Exception:
			frappe.log_error(frappe.get_traceback(),
				"v37 reservation trip-flags backfill failed: " + str(name))
	frappe.db.commit()
	frappe.logger("patches").info(
		{"patch": "v37_reservation_trip_flags",
		 "total": len(names), "changed": changed})
