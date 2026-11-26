# Copyright (c) 2026, WargaPrihatan and contributors
# For license information, please see license.txt

import frappe
from frappe.model.document import Document


class FlightSchedule(Document):
	# begin: auto-generated types
	# This code is auto-generated. Do not modify anything in this block.

	from typing import TYPE_CHECKING

	if TYPE_CHECKING:
		from frappe.types import DF
		from travel_booking.module_travel_booking.doctype.flight_schedule_flight.flight_schedule_flight import FlightScheduleFlight

		flights: DF.Table[FlightScheduleFlight]
		notes: DF.SmallText | None
		schedule_code: DF.Data | None
		status: DF.Literal["Draft", "Active", "Closed", "Completed"]
	# end: auto-generated types

	_DOCTYPE_NAME = "Flight Schedule"

	def validate(self):
		self.validate_unique_flights()

	def validate_unique_flights(self):
		"""Satu PNR sahaja sekali dalam set — elak kiraan kerusi berganda
		dan kekeliruan aliran assignment (bulk_assign_flight merujuk PNR
		tunggal; duplikasi dalam set tak menambah kapasiti)."""
		seen = set()
		for row in (self.flights or []):
			if not row.flight:
				continue
			if row.flight in seen:
				frappe.throw(
					"Flight {0} appears more than once in this schedule.".format(
						row.flight),
					title="Duplicate Flight",
				)
			seen.add(row.flight)
