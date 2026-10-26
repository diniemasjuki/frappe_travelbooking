import frappe


def execute():
	"""Migrasi room_id tersuai (renamed manual) → Booking Room Alias.

	room_id Booking Reservation dikembalikan kepada nilai AUTO
	('[booking_number]-Room_[cabin_no]' — mirror assign_room_id()); nama
	paparan tersuai dipindahkan ke Booking Room Alias (sekali per bilik).
	Idempoten — hanya sentuh room_id yang ≠ label auto.

	GUARD (dipelajari daripada data trip.rarecation.com): room_id milik
	BOOKING LAIN ('<booking_number_lain>-Room_<n>') ialah PENEMPATAN
	Open Sharing merentas booking — BUKAN nama tersuai; jangan sentuh
	(kerosakan sebegini dibetulkan oleh patch v35). Auto ID yang
	dihantar kembali ke Reservation semasa migrasi juga WAJIB guna
	booking_number Booking (snapshot br.booking_number kerap kosong
	pada rekod dicipta server-side — fallback ke Booking, cache).
	"""
	bookings_bnum = {}
	for r in frappe.get_all("Booking Reservation",
			fields=["name", "booking", "cabin_no", "room_id", "booking_number"]):
		if not r.room_id or not r.cabin_no or not r.booking:
			continue
		# booking_number snapshot reservation kerap kosong (rekod
		# server-side) — fallback ke Booking sekali, cache.
		ref = r.booking_number or bookings_bnum.get(r.booking)
		if not ref:
			ref = frappe.db.get_value("Booking", r.booking, "booking_number") or r.booking
			bookings_bnum[r.booking] = ref
		auto = "{0}-Room_{1}".format(ref, r.cabin_no)
		if r.room_id == auto:
			continue
		# GUARD: room_id milik booking lain = penempatan Open Sharing
		# merentas booking (bukan nama tersuai) — KEKAL sepenuhnya.
		if "-Room_" in r.room_id:
			owner_ref = r.room_id.split("-Room_")[0]
			if owner_ref != ref:
				continue
		alias_name = "ROOMALIAS-{0}-{1}".format(r.booking, r.cabin_no)
		if not frappe.db.exists("Booking Room Alias", alias_name):
			frappe.get_doc({
				"doctype": "Booking Room Alias",
				"booking": r.booking,
				"cabin_no": r.cabin_no,
				"custom_name": r.room_id,
			}).insert(ignore_permissions=True)
		frappe.db.set_value("Booking Reservation", r.name,
			"room_id", auto, update_modified=False)
	frappe.db.commit()
