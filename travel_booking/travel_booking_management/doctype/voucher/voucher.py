# Copyright (c) 2026, WargaPrihatin and contributors
# For license information, please see license.txt

# import frappe
from frappe.model.document import Document


class Voucher(Document):
	# begin: auto-generated types
	# This code is auto-generated. Do not modify anything in this block.

	from typing import TYPE_CHECKING

	if TYPE_CHECKING:
		from frappe.types import DF
		from travel_booking.travel_booking_management.doctype.voucher_usage.voucher_usage import VoucherUsage

		discount_value: DF.Float
		max_uses: DF.Int
		room_category: DF.Link | None
		status: DF.Literal["Active", "Inactive", "Expired"]
		trip: DF.Link | None
		trip_date: DF.Link | None
		usage: DF.Table[VoucherUsage]
		used_count: DF.Int
		valid_from: DF.Datetime | None
		valid_to: DF.Datetime | None
		voucher_code: DF.Data
		voucher_type: DF.Literal["Percentage", "Fixed Amount"]
	# end: auto-generated types

	_DOCTYPE_NAME = "Voucher"
