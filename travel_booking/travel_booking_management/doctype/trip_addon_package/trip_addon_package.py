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
		from travel_booking.travel_booking_management.doctype.trip_scoping.trip_scoping import TripScoping

		addon: DF.Link
		addon_package_name: DF.Data | None
		addon_title: DF.Data | None
		applicable_to: DF.Literal["All Trips", "Specific Trips Only"]
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
		scope: DF.Literal["Per Booking", "Per Pax"]
		status: DF.Literal["Active", "Inactive"]
		trip_scoping: DF.Table[TripScoping]
		unit_price: DF.Currency
		valid_from_offset_days: DF.Int
		valid_to_offset_days: DF.Int
		validity_mode: DF.Literal["One-Off", "Same as Trip", "Relative to Departure", "Fixed Dates"]
	# end: auto-generated types

	_DOCTYPE_NAME = "Trip Addon Package"

	def validate(self):
		self.set_currency_and_unit_price()
		self.validate_validity_rule()
		self.validate_scoping()

	def set_currency_and_unit_price(self):
		"""Currency selalu ikut Addon induk (fetch_from, tapi dipastikan semula
		di sini sebab fetch_from client-side boleh tak jalan untuk operasi
		backend/API). unit_price = price_override kalau diisi, jika tidak
		guna Addon.base_price.
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

	def validate_scoping(self):
		"""Validate trip scoping child table.

		Jika applicable_to = 'Specific Trips Only', mestikan sekurang-kurang
		satu trip scoping ditetapkan. Jika 'All Trips', boleh kosong.
		"""
		scopings = self.get("trip_scoping", [])

		if self.applicable_to == "Specific Trips Only" and not scopings:
			frappe.throw(
				"This addon is marked as 'Specific Trips Only' but no trip/date/package "
				"scoping is specified. Please add at least one entry in 'Trip & Date Scoping' table."
			)

	def is_applicable_for_trip_package(self, trip_package_name=None, group_date_name=None):
		"""Check if this addon package is applicable for a given trip package or group date.

		Returns True if:
		- applicable_to = 'All Trips' (global, available for all bookings)
		- OR scoping exists and matches the given trip_package/group_date
		"""
		scopings = frappe.get_all("Trip Scoping", {"parent": self.name}, ["trip_package", "group_date", "trip"])

		if self.applicable_to == "All Trips":
			return True

		for scope in scopings:
			if trip_package_name and scope.trip_package == trip_package_name:
				return True
			if group_date_name and scope.group_date == group_date_name:
				return True
			if scope.trip and not trip_package_name and not group_date_name:
				return True

		return False
