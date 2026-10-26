import frappe


def execute():
	"""Migrasi aliran status Booking Reservation (options lama → baharu):

	- 'Confirmed' / 'Pending Review' → dikira semula ikut aliran auto
	  (Waiting Document / Document Completed / Trip OnProgress / Document
	  Expired / Completed — rujuk BookingReservation.compute_auto_status).
	- 'Expired Document' → juga dikira semula; aliran baharu mentakrifkan
	  Document Expired secara AUTO (luput passport < 6 bulan dari
	  departure), bukan tanda manual.
	- 'Cancelled' → dikekalkan (terminal; compute_auto_status takkan
	  ketuk Cancelled tanpa rule yang mengatasi).

	Status Traveller & document_status TIDAK disentuh — patch ini hanya
	field status aliran reservation.
	"""
	# Options Select sudah disegerak oleh sync doctype sebelum patches
	# berjalan — nilai lama dalam DB tidak lagi sah, jadi kira semula.
	names = frappe.get_all("Booking Reservation", pluck="name")
	changed = 0
	for name in names:
		try:
			doc = frappe.get_doc("Booking Reservation", name)
			new_status = doc.compute_auto_status()
			if new_status and new_status != doc.status:
				frappe.db.set_value("Booking Reservation", name,
					"status", new_status, update_modified=False)
				changed += 1
		except Exception:
			frappe.log_error(frappe.get_traceback(),
				"v32 reservation status migration failed: " + str(name))
	frappe.db.commit()
	frappe.logger("patches").info(
		{"patch": "v32_reservation_status_flow",
		 "total": len(names), "changed": changed})
