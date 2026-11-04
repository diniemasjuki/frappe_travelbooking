# Copyright (c) 2026, WargaPrihatin and contributors
# For license information, please see license.txt

import frappe
from frappe.model.document import Document


class OfferInventory(Document):
	# begin: auto-generated types
	# This code is auto-generated. Do not modify anything in this block.

	from typing import TYPE_CHECKING

	if TYPE_CHECKING:
		from frappe.types import DF

		inventory_key: DF.Data
		allotment: DF.Int
		sold: DF.Int
		available: DF.Int
	# end: auto-generated types

	_DOCTYPE_NAME = "Offer Inventory"

