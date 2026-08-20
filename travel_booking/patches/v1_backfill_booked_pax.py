"""Backfill Booking.booked_pax untuk booking sedia ada (sebelum field ditambah).

`booked_pax` ialah sumber kebenaran untuk gate overbooking di
`confirm_booking` — ia mengira SEMUA pax (Main Guest + Extra Bed + Infant)
bagi sesuatu booking pada masa ia dicipta, termasuk booking Pending yang
belum ada Booking Reservation row (reservation row dicipta semasa bayaran).

Untuk booking baru, `booked_pax` diset di `confirm_booking`. Patch ni
mengisi booking lama. Sumber terbaik yang ada ialah kiraan Booking
Reservation row (setiap row = satu pax, ada `pax_type`). Ini best-effort:

- Booking Confirmed/Paid (ada reservation row) -> `booked_pax` = bilangan
  row tak-cancelled (tepat, sepadan dengan virtual `total_pax`).
- Booking Pending lama (tiada reservation row) -> `booked_pax = 0`
  (undercount; caveat diiktiraf). Gate forward-looking kekal betul untuk
  booking baharu.
"""

import frappe


def execute():
	# Booking yang belum diset dengan betul. Frappe initialize column Int
	# baharu kepada 0 (BUKAN NULL) pada baris sedia ada, jadi semak kedua-dua
	# NULL dan 0. Booking baru yang dicipta oleh confirm_booking sentiasa
	# mempunyai booked_pax >= 1 (pengesahan ketatkan min 1 Main Guest),
	# jadi booked_pax = 0 hanya berlaku pada booking pra-migrasi — selamat
	# tulis semula tanpa ganggu booking baharu.
	bookings = frappe.db.sql_list(
		"""
		SELECT name FROM `tabBooking`
		WHERE booked_pax IS NULL OR booked_pax = 0
		"""
	)
	if not bookings:
		return

	# Kira Booking Reservation row tak-cancelled (Confirmed + lain-lain
	# status kecuali Cancelled) bagi setiap booking. Guna GROUP BY untuk
	# satu round-trip sahaja.
	rows = frappe.db.sql(
		"""
		SELECT booking, COUNT(*) AS cnt
		FROM `tabBooking Reservation`
		WHERE booking IN %s AND status != 'Cancelled'
		GROUP BY booking
		""",
		(tuple(bookings),),
		as_dict=True,
	)
	counts = {r.booking: int(r.cnt or 0) for r in rows}

	for name in bookings:
		frappe.db.set_value(
			"Booking",
			name,
			"booked_pax",
			counts.get(name, 0),
			update_modified=False,
		)
