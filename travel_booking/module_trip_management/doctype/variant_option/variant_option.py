# Copyright (c) 2026, WargaPrihatin and contributors
# For license information, please see license.txt

import frappe
from frappe.model.document import Document


class VariantOption(Document):
	# begin: auto-generated types
	# This code is auto-generated. Do not modify anything in this block.

	from typing import TYPE_CHECKING

	if TYPE_CHECKING:
		from frappe.types import DF

		axis_code: DF.Data
		option_code: DF.Data
		option_name: DF.Data
		sort_order: DF.Int
	# end: auto-generated types

	_DOCTYPE_NAME = "Variant Option"

