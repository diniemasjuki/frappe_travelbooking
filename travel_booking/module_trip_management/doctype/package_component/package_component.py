# Copyright (c) 2026, WargaPrihatin and contributors
# For license information, please see license.txt

import frappe
from frappe.model.document import Document


class PackageComponent(Document):
	# begin: auto-generated types
	# This code is auto-generated. Do not modify anything in this block.

	from typing import TYPE_CHECKING

	if TYPE_CHECKING:
		from frappe.types import DF

		component_type: DF.Literal["cruise_tour", "flight", "activity", "merchandise"]
		trip: DF.Link | None  # Trip
		flight: DF.Link | None  # Flight
		component_item: DF.Link | None  # Item
		selection_mode: DF.Literal["fixed", "customer_pick", "optional"]
		qty: DF.Int
		mandatory: DF.Check
		price_adjust_type: DF.Literal["none", "percent", "amount"]
		price_adjust_value: DF.Currency
		sort_order: DF.Int
	# end: auto-generated types

	_DOCTYPE_NAME = "Package Component"

