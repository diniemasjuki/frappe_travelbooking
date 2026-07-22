# Copyright (c) 2026, WargaPrihatin and contributors
# For license information, please see license.txt

# import frappe
from frappe.model.document import Document


class RoomPricing(Document):
	# begin: auto-generated types
	# This code is auto-generated. Do not modify anything in this block.

	from typing import TYPE_CHECKING

	if TYPE_CHECKING:
		from frappe.types import DF

		parent: DF.Data
		parentfield: DF.Data
		parenttype: DF.Data
		price_child: DF.Currency
		price_infant: DF.Currency
		price_single: DF.Currency
		price_third: DF.Currency
		price_twin: DF.Currency
		room_category: DF.Link
	# end: auto-generated types

	_DOCTYPE_NAME = "Room Pricing"
