# Copyright (c) 2026, WargaPrihatin and contributors
# For license information, please see license.txt

# import frappe
from frappe.model.document import Document


class TripPriceCategory(Document):
	# begin: auto-generated types
	# This code is auto-generated. Do not modify anything in this block.

	from typing import TYPE_CHECKING

	if TYPE_CHECKING:
		from frappe.types import DF

		capacity: DF.Int
		category_code: DF.Data | None
		category_name: DF.Data
		description: DF.TextEditor | None
		gred: DF.Rating
		is_a_cruise: DF.Check
		max_capacity: DF.Int
		room_profile: DF.AttachImage | None
		room_type: DF.Literal["", "Cabin", "Suite", "Villa", "Room"]
	# end: auto-generated types

	_DOCTYPE_NAME = "Trip Price Category"