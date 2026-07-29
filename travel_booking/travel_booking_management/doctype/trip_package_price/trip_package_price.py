# Copyright (c) 2026, WargaPrihatin and contributors
# For license information, please see license.txt

# import frappe
from frappe.model.document import Document


class TripPackagePrice(Document):
	# begin: auto-generated types
	# This code is auto-generated. Do not modify anything in this block.

	from typing import TYPE_CHECKING

	if TYPE_CHECKING:
		from frappe.types import DF

		parent: DF.Data
		parentfield: DF.Data
		parenttype: DF.Data
		price_adult: DF.Currency
		price_adult_single: DF.Currency
		price_adult_upperberth: DF.Currency
		price_children: DF.Currency
		price_infant: DF.Currency
		price_toddler: DF.Currency
		price_variant_code: DF.Data | None
		pricing_for_class: DF.Link
	# end: auto-generated types

	_DOCTYPE_NAME = "Trip Package Price"


	def validate(self):

		if not self.price_variant_code:
			self.price_variant_code = self.parent + "-" + self.pricing_for_class