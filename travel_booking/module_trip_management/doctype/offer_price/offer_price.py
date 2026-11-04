# Copyright (c) 2026, WargaPrihatin and contributors
# For license information, please see license.txt

import frappe
from frappe.model.document import Document


class OfferPrice(Document):
	# begin: auto-generated types
	# This code is auto-generated. Do not modify anything in this block.

	from typing import TYPE_CHECKING

	if TYPE_CHECKING:
		from frappe.types import DF

		price_key: DF.Data
		opt1: DF.Data | None
		opt2: DF.Data | None
		opt3: DF.Data | None
		age_option: DF.Literal["", "ADULT", "CHILD", "INFANT", "TODDLER"]
		currency: DF.Link | None  # Currency
		price: DF.Currency
		active: DF.Check
	# end: auto-generated types

	_DOCTYPE_NAME = "Offer Price"

