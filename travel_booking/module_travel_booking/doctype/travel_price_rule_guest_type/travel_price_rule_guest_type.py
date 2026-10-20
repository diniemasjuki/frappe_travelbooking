# Copyright (c) 2026, WargaPrihatin and contributors
# For license information, please see license.txt

# import frappe
from frappe.model.document import Document


class TravelPriceRuleGuestType(Document):
	# begin: auto-generated types
	# This code is auto-generated. Do not modify anything in this block.

	from typing import TYPE_CHECKING

	if TYPE_CHECKING:
		from frappe.types import DF

		parent: DF.Data
		parentfield: DF.Data
		parenttype: DF.Data
		price_key: DF.Literal[
			"price_adult",
			"price_adult_single",
			"price_upperberth",
			"price_children",
			"price_toddler",
			"price_infant",
		]
	# end: auto-generated types

	_DOCTYPE_NAME = "Travel Price Rule Guest Type"
