# Copyright (c) 2026, WargaPrihatin and contributors
# For license information, please see license.txt

import frappe

import re
from frappe.utils import getdate
from frappe.utils import date_diff

from frappe.model.document import Document


class TripCruiseSchedule(Document):
	# begin: auto-generated types
	# This code is auto-generated. Do not modify anything in this block.

	from typing import TYPE_CHECKING

	if TYPE_CHECKING:
		from frappe.types import DF
		from travel_booking.travel_booking_management.doctype.trip_package_price.trip_package_price import TripPackagePrice

		cabin_rates: DF.Table[TripPackagePrice]
		cruise_line_company: DF.Link | None
		naming_series: DF.Literal[".ship_code.YY.#"]
		port_end: DF.Link
		port_start: DF.Link
		sail_end: DF.Date
		sail_start: DF.Date
		schedule_code: DF.Data | None
		ship_code: DF.Literal["AC01", "HV01"]
		ship_name: DF.Data | None
		status: DF.Literal["Pending Review", "Active", "Inactive", "Canceled"]
		total_days: DF.Int
		trip_code: DF.Data | None
		trip_link: DF.Link | None
		trip_name: DF.Data | None
	# end: auto-generated types

	_DOCTYPE_NAME = "Trip Cruise Schedule"

	def validate(self):

		if self.trip_code:
			self.trip_code = self.trip_code.upper().strip()
			code = self.trip_code

		if self.sail_start and self.sail_end:
			self.schedule_code = ( self.ship_code + " : " + frappe.utils.getdate(self.sail_start).strftime("%Y-%m-%d") ).upper().strip()

		if self.sail_start and self.sail_end:

			if self.sail_start:
				sail_start = self.sail_start

			if self.sail_end:
				sail_end = self.sail_end

			if sail_start > sail_end:
				frappe.throw("SAILING START DATE must earlier then SAILING END DATE")

			self.total_days = date_diff(self.sail_end, self.sail_start)+1