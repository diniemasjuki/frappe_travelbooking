# Copyright (c) 2026, WargaPrihatin and contributors
# For license information, please see license.txt

import frappe
import re
from frappe.model.document import Document


class Trip(Document):
	# begin: auto-generated types
	# This code is auto-generated. Do not modify anything in this block.

	from typing import TYPE_CHECKING

	if TYPE_CHECKING:
		from frappe.types import DF
		from travel_booking.travel_booking_management.doctype.trip_destination_point_select.trip_destination_point_select import TripDestinationPointSelect

		description: DF.TextEditor | None
		destination_list: DF.TableMultiSelect[TripDestinationPointSelect]
		is_a_cruise_trip: DF.Check
		status: DF.Literal["Pending Review", "Active", "Completed", "Cancelled"]
		trip_code: DF.Data | None
		trip_image: DF.AttachImage | None
		trip_name: DF.Data
		trip_organizer: DF.Link
	# end: auto-generated types

	_DOCTYPE_NAME = "Trip"

	def validate(self):

		if self.trip_code:
			self.trip_code = re.sub(r'[^a-zA-Z0-9]', '', self.trip_code).upper().replace(" ","")
		else:
			self.trip_code = self.name