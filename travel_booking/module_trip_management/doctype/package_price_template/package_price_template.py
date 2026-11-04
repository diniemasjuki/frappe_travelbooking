# Copyright (c) 2026, WargaPrihatin and contributors
# For license information, please see license.txt

import frappe
from frappe.model.document import Document


class PackagePriceTemplate(Document):
	# begin: auto-generated types
	# This code is auto-generated. Do not modify anything in this block.

	from typing import TYPE_CHECKING

	if TYPE_CHECKING:
		from frappe.types import DF

		opt1: DF.Data | None
		opt2: DF.Data | None
		opt3: DF.Data | None
		age_option: DF.Literal["", "ADULT", "CHILD", "INFANT", "TODDLER"]
		currency: DF.Link | None  # Currency
		price: DF.Currency
		active: DF.Check
		price_key: DF.Data | None
	# end: auto-generated types

	_DOCTYPE_NAME = "Package Price Template"

	def validate(self):
		parts = [self.opt1, self.opt2, self.opt3, self.age_option]
		self.price_key = "|".join(p for p in parts if p)
