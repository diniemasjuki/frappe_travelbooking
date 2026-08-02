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
		from travel_booking.travel_booking_management.doctype.voucher_applicable_package.voucher_applicable_package import VoucherApplicablePackage
		from travel_booking.travel_booking_management.doctype.voucher_applicable_room_category.voucher_applicable_room_category import VoucherApplicableRoomCategory
		from travel_booking.travel_booking_management.doctype.voucher_applicable_trip.voucher_applicable_trip import VoucherApplicableTrip
		from travel_booking.travel_booking_management.doctype.voucher_usage.voucher_usage import VoucherUsage

		applicable_packages: DF.TableMultiSelect[VoucherApplicablePackage]
		applicable_room_categories: DF.TableMultiSelect[VoucherApplicableRoomCategory]
		applicable_trips: DF.TableMultiSelect[VoucherApplicableTrip]
		discount_type: DF.Literal["Percentage", "Fixed Amount"]
		discount_value: DF.Currency
		max_usage: DF.Int
		max_usage_per_customer: DF.Int
		status: DF.Literal["Active", "Inactive", "Expired"]
		usage: DF.Table[VoucherUsage]
		valid_from: DF.Date
		valid_until: DF.Date
		voucher_code: DF.Data
	# end: auto-generated types

	_DOCTYPE_NAME = "Voucher"
