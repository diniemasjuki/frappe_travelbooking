# Copyright (c) 2026, WargaPrihatin and contributors
# For license information, please see license.txt

import frappe
from frappe.model.document import Document


class OfferComponent(Document):
	# begin: auto-generated types
	# This code is auto-generated. Do not modify anything in this block.

	from typing import TYPE_CHECKING

	if TYPE_CHECKING:
		from frappe.types import DF

		component_type: DF.Literal["cruise_tour", "flight", "activity", "merchandise"]
		trip: DF.Link | None  # Trip
		flight: DF.Link | None  # Flight
		cruise_schedule: DF.Link | None  # Trip Cruise Schedule
		resolved_start: DF.Date
		resolved_end: DF.Date
	# end: auto-generated types

	_DOCTYPE_NAME = "Offer Component"

