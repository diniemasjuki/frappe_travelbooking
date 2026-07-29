# Copyright (c) 2026, WargaPrihatin and contributors
# For license information, please see license.txt

import frappe
import re
from frappe.model.document import Document

class Flight(Document):
	# begin: auto-generated types
	# This code is auto-generated. Do not modify anything in this block.

	from typing import TYPE_CHECKING

	if TYPE_CHECKING:
		from frappe.types import DF

		airline: DF.Link
		arrival_date: DF.Date | None
		departure_date: DF.Date | None
		destination_airport: DF.Link
		flight_class: DF.Literal["Economy", "Economy Plus", "Premium Economy", "First Class", "Business Class"]
		flight_itinerary: DF.TextEditor | None
		flight_title: DF.Data | None
		home_airport: DF.Link
		max_seat: DF.Int
		min_seat: DF.Int
		pnr: DF.Data
		return_arrival_date: DF.Date | None
		return_date: DF.Date | None
		seats_occupied: DF.Int
		status: DF.Literal["Open", "Full", "Closed", "Completed"]
		ticket_type: DF.Literal["FIT", "GIT"]
		view_pnr: DF.ReadOnly | None
	# end: auto-generated types

	_DOCTYPE_NAME = "Flight"

	def refresh_seats(self):
		"""Kira seats_occupied dari Booking Reservation yang assign ke Flight ini."""
		filled = frappe.db.count("Booking Reservation", {"flight": self.name})
		frappe.db.set_value("Flight", self.name, "seats_occupied", filled,
							update_modified=False)

	def validate(self):

		if self.pnr:
			self.pnr = re.sub(r'[^a-zA-Z0-9]', '', self.pnr).upper().replace(" ","")

		self.flight_title = self.pnr + "-" + self.airline + "-" + self.home_airport + "-" + self.destination_airport
		self.flight_title = self.flight_title.upper().strip()