# Copyright (c) 2026, WargaPrihatin and contributors
# For license information, please see license.txt

# import frappe
from frappe.model.document import Document


class TripPackage(Document):
	# begin: auto-generated types
	# This code is auto-generated. Do not modify anything in this block.

	from typing import TYPE_CHECKING

	if TYPE_CHECKING:
		from frappe.types import DF
		from travel_booking.travel_booking_management.doctype.room_pricing.room_pricing import RoomPricing

		flight: DF.Link | None
		package_name: DF.Data
		package_pricing: DF.Table[RoomPricing]
		package_type: DF.Literal["Cruise Only", "With Flight"]
		status: DF.Literal["Active", "Inactive"]
		trip_date: DF.Link
		trip_name: DF.Link | None
	# end: auto-generated types

	_DOCTYPE_NAME = "Trip Package"
