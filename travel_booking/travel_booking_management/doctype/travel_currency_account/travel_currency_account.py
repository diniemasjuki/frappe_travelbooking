# Copyright (c) 2026, WargaPrihatin and contributors
# For license information, please see license.txt

# import frappe
from frappe.model.document import Document


class TravelCurrencyAccount(Document):
	# begin: auto-generated types
	# This code is auto-generated. Do not modify anything in this block.

	from typing import TYPE_CHECKING

	if TYPE_CHECKING:
		from frappe.types import DF

		bank_account: DF.Link | None
		currency: DF.Link | None
		manual_transfer_paid_to_account: DF.Link | None
		parent: DF.Data
		parentfield: DF.Data
		parenttype: DF.Data
		payment_gateway_account: DF.Link | None
	# end: auto-generated types

	_DOCTYPE_NAME = "Travel Currency Account"
