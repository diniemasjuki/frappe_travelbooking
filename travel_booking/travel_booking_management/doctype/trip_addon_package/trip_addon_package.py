# Copyright (c) 2026, WargaPrihatin and contributors
# For license information, please see license.txt

import frappe
from frappe.model.document import Document


class TripAddonPackage(Document):
	# begin: auto-generated types
	# This code is auto-generated. Do not modify anything in this block.

	from typing import TYPE_CHECKING

	if TYPE_CHECKING:
		from frappe.types import DF

		addon: DF.Link
		addon_title: DF.Data | None
		currency: DF.Link | None
		current_qty_sold: DF.Int
		fixed_valid_from: DF.Date | None
		fixed_valid_to: DF.Date | None
		max_qty_per_booking: DF.Int
		max_total_qty: DF.Int
		naming_series: DF.Literal["AP.YY.MM.###"]
		price_override: DF.Currency
		sales_cutoff_days_before_departure: DF.Int
		sales_cutoff_enabled: DF.Check
		status: DF.Literal["Active", "Inactive"]
		trip_package: DF.Link | None
		unit_price: DF.Currency
		valid_from_offset_days: DF.Int
		valid_to_offset_days: DF.Int
		validity_mode: DF.Literal["Same as Trip", "Relative to Departure", "Fixed Dates", "One-Off"]
	# end: auto-generated types

	_DOCTYPE_NAME = "Addon Package"

	def validate(self):
		self.set_currency_and_unit_price()
		self.validate_validity_rule()

	def set_currency_and_unit_price(self):
		"""Currency selalu ikut Addon induk (fetch_from, tapi dipastikan semula
		di sini sebab fetch_from client-side boleh tak jalan untuk operasi
		backend/API). unit_price = price_override kalau diisi, jika tidak
		guna Addon.base_price — dikira SEKALI di sini (bukan virtual), supaya
		boleh di-list/sort/report macam field biasa (rujuk pattern
		Booking.prog_payment — field agregat yang perlu tampil di List View
		WAJIB stored, bukan @property).
		"""
		if not self.addon:
			return
		addon_currency, addon_base_price = frappe.db.get_value(
			"Trip Addon", self.addon, ["currency", "base_price"]
		)
		self.currency = addon_currency or "MYR"
		if self.price_override is not None and self.price_override > 0:
			self.unit_price = self.price_override
		else:
			self.unit_price = addon_base_price or 0

	def validate_validity_rule(self):
		if self.validity_mode == "Fixed Dates":
			if self.fixed_valid_from and self.fixed_valid_to:
				if frappe.utils.getdate(self.fixed_valid_from) > frappe.utils.getdate(self.fixed_valid_to):
					frappe.throw("Fixed Valid From must be earlier than Fixed Valid To.")
		elif self.validity_mode == "Relative to Departure":
			if (
				self.valid_from_offset_days is not None
				and self.valid_to_offset_days is not None
				and self.valid_from_offset_days > self.valid_to_offset_days
			):
				frappe.throw("Valid From Offset must not be greater than Valid To Offset.")