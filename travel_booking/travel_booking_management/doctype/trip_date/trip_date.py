# Copyright (c) 2026, WargaPrihatin and contributors
# For license information, please see license.txt

import frappe
from frappe.model.document import Document


class TripDate(Document):
	# begin: auto-generated types
	# This code is auto-generated. Do not modify anything in this block.

	from typing import TYPE_CHECKING

	if TYPE_CHECKING:
		from frappe.types import DF

		cruise_line: DF.Data | None
		departure_date: DF.Date | None
		disembarkation_port: DF.Data | None
		embarkation_port: DF.Data | None
		return_date: DF.Date | None
		sailing_end: DF.Date | None
		sailing_no: DF.Data
		sailing_start: DF.Date | None
		ship_name: DF.Data | None
		status: DF.Literal["Active", "Full", "Cancelled", "Completed"]
		total_bookings: DF.Int
		total_capacity: DF.Int
		trip_master: DF.Link
	# end: auto-generated types

	_DOCTYPE_NAME = "Trip Date"

	def refresh_bookings(self):
		"""Kira jumlah pax (Reservation) untuk semua Booking bawah Trip Date ini."""
		total = frappe.db.sql("""
			SELECT COUNT(r.name)
			FROM `tabReservation` r
			JOIN `tabBooking` b ON b.name = r.booking
			WHERE b.trip_date = %s
				AND b.status != 'Cancelled'
		""", self.name)[0][0] or 0

		frappe.db.set_value("Trip Date", self.name, "total_bookings", total,
							update_modified=False)

	@property
	def available_slots(self):
		return (self.total_capacity or 0) - (self.total_bookings or 0)
