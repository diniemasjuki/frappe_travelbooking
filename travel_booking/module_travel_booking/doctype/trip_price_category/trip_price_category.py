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
		category_group: DF.Literal["", "Cabin", "Suite", "Villa", "Room", "Addon"]
		category_name: DF.Data
		description: DF.SmallText | None
		gred: DF.Rating
		max_capacity: DF.Int
		price_category: DF.Literal["Cruise", "Tour", "Hotel", "Transport", "Meal", "Flight"]
		read_more_url: DF.Data | None
		room_profile: DF.AttachImage | None
		youtube_url: DF.Data | None
	# end: auto-generated types

	_DOCTYPE_NAME = "Trip Price Category"