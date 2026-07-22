# Copyright (c) 2026, WargaPrihatin and contributors
# For license information, please see license.txt

# import frappe
from frappe.model.document import Document


class TripMaster(Document):
	# begin: auto-generated types
	# This code is auto-generated. Do not modify anything in this block.

	from typing import TYPE_CHECKING

	if TYPE_CHECKING:
		from frappe.types import DF

		description: DF.TextEditor | None
		duration_days: DF.Int
		duration_nights: DF.Int
		route_summary: DF.Data | None
		status: DF.Literal["Active", "Completed", "Cancelled"]
		trip_code: DF.Data | None
		trip_name: DF.Data
		trip_type: DF.Literal["Rarecation", "Rarecruise"]
	# end: auto-generated types

	_DOCTYPE_NAME = "Trip Master"
