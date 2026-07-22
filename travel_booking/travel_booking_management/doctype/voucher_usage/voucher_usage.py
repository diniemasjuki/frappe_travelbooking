# Copyright (c) 2026, WargaPrihatin and contributors
# For license information, please see license.txt

# import frappe
from frappe.model.document import Document


class VoucherUsage(Document):
	# begin: auto-generated types
	# This code is auto-generated. Do not modify anything in this block.

	from typing import TYPE_CHECKING

	if TYPE_CHECKING:
		from frappe.types import DF

		booking: DF.Link | None
		customer: DF.Link
		discount_applied: DF.Currency
		parent: DF.Data
		parentfield: DF.Data
		parenttype: DF.Data
		used_date: DF.Datetime | None
	# end: auto-generated types

	_DOCTYPE_NAME = "Voucher Usage"
