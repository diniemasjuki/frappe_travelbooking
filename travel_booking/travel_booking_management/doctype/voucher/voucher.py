# Copyright (c) 2026, WargaPrihatin and contributors
# For license information, please see license.txt

import frappe
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

		applicable_packages: DF.TableMultiSelect[VoucherApplicablePackage]
		applicable_room_categories: DF.TableMultiSelect[VoucherApplicableRoomCategory]
		applicable_trips: DF.TableMultiSelect[VoucherApplicableTrip]
		currency: DF.Link | None
		discount_type: DF.Literal["Percentage", "Fixed Amount"]
		discount_value: DF.Currency
		max_usage: DF.Int
		max_usage_per_customer: DF.Int
		status: DF.Literal["Active", "Inactive", "Expired"]
		valid_from: DF.Date
		valid_until: DF.Date
		voucher_code: DF.Data
	# end: auto-generated types

	_DOCTYPE_NAME = "Voucher"

	def validate(self):
		self.voucher_code = self.voucher_code.upper() if self.voucher_code else None

		# Fixed Amount voucher WAJIB ber-currency & currency mesti
		# diisytiharkan dalam paksi axis (Travel Settings > Multi Currency
		# Account) — nilai fixed hanya bermakna dalam satu currency.
		# Percentage diabaikan (relatif semua currency).
		if self.discount_type == "Fixed Amount":
			if not self.currency:
				frappe.throw(
					"Fixed Amount vouchers must have a Currency (e.g. MYR) — "
					"a fixed value is only meaningful in one currency.",
					title="Voucher Currency Required",
				)
			from travel_booking.api.currency_axis import get_declared_currencies
			declared = get_declared_currencies()
			if declared and self.currency not in declared:
				frappe.throw(
					"Voucher currency '{0}' is not declared in Travel Settings > "
					"Multi Currency Account. Available: {1}.".format(
						self.currency, ", ".join(sorted(declared))
					),
					title="Invalid Voucher Currency",
				)

	def before_insert(self):
		self.validate()

	# FIXED: before_update() bukan hook Frappe yang sah — guna before_save()
	def before_save(self):
		self.validate()