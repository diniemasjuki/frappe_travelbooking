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
		from travel_booking.travel_booking_management.doctype.trip_addon_package_rate.trip_addon_package_rate import TripAddonPackageRate
		from travel_booking.travel_booking_management.doctype.trip_scoping.trip_scoping import TripScoping

		addon: DF.Link
		addon_package_name: DF.Data | None
		addon_title: DF.Data | None
		applicable_to: DF.Literal["All Trips", "Specific Trips Only"]
		currency_rates: DF.Table[TripAddonPackageRate]
		current_qty_sold: DF.Int
		fixed_valid_from: DF.Date | None
		fixed_valid_to: DF.Date | None
		max_qty_per_booking: DF.Int
		max_total_qty: DF.Int
		naming_series: DF.Literal["AP.YY.MM.###"]
		sales_cutoff_days_before_departure: DF.Int
		sales_cutoff_enabled: DF.Check
		scope: DF.Literal["Per Booking", "Per Pax"]
		status: DF.Literal["Active", "Inactive"]
		trip_scoping: DF.Table[TripScoping]
		valid_from_offset_days: DF.Int
		valid_to_offset_days: DF.Int
		validity_mode: DF.Literal["One-Off", "Same as Trip", "Relative to Departure", "Fixed Dates"]
	# end: auto-generated types

	_DOCTYPE_NAME = "Trip Addon Package"

	def validate(self):
		self.validate_validity_rule()
		self.validate_scoping()
		self.validate_currency_rates()

	def validate_currency_rates(self):
		"""Paksi harga multi-currency: setiap baris rate mesti currency yang
		diisytiharkan dalam Travel Settings > Multi Currency Account, dan
		currency unik per pakej (dua baris currency sama buat resolusi
		harga ambiguous).
		"""
		from travel_booking.api.currency_axis import get_declared_currencies

		declared = get_declared_currencies()
		seen = set()
		for row in (self.currency_rates or []):
			if not row.currency:
				continue
			if declared and row.currency not in declared:
				frappe.throw(
					"Rate row currency '{0}' is not declared in Travel Settings > "
					"Multi Currency Account. Available: {1}.".format(
						row.currency, ", ".join(sorted(declared))
					),
					title="Invalid Rate Currency",
				)
			if row.currency in seen:
				frappe.throw(
					"Currency '{0}' appears more than once in Currency Rates — "
					"only one rate per currency is allowed.".format(row.currency),
					title="Duplicate Rate Currency",
				)
			seen.add(row.currency)
			if row.enabled and (row.unit_price is None or float(row.unit_price or 0) < 0):
				frappe.throw(
					"Rate for '{0}' must have a unit price (>= 0).".format(row.currency),
					title="Missing Rate Price",
				)

	def get_rate_for_currency(self, currency):
		"""Harga jualan dalam currency tertentu, atau None.

		Hanya guna baris rate enabled dalam currency_rates — tiada
		fallback legacy. Pulangkan (unit_price, 'rates') atau (None, None).
		"""
		for row in (self.currency_rates or []):
			if row.currency == currency and row.enabled:
				return float(row.unit_price or 0), "rates"
		return None, None

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

	def is_applicable_for_trip_package(self, trip_package_name=None, group_date_name=None, trip_name=None):
		"""Check if this addon package is applicable for a given trip / group date / package.

		Returns True if:
		- applicable_to = 'All Trips' (global, available for all bookings)
		- OR scoping exists and matches the given trip_package/group_date/trip

		Semantik row scoping (kepihakan lebih spesifik menang):
		- row dengan trip_package → hanya booking dengan Trip Package sama
		- row dengan group_date  → hanya booking dengan Trip Group Date sama
		- row dengan trip SAHAJA (tiada date/package) → SEMUA booking bagi
		  Trip tersebut. (Bug lama: padanan trip-level hanya berjalan bila
		  booking TIADA package & group date — hampir mustahil untuk booking
		  sebenar — menyebabkan addon scoped "trip sahaja" tak pernah muncul
		  di page booking_addons.)
		"""
		scopings = frappe.get_all("Trip Scoping", {"parent": self.name}, ["trip_package", "group_date", "trip"])

		if self.applicable_to == "All Trips":
			return True

		for scope in scopings:
			# Row trip+package (tiada group date): sah untuk package tertentu
			# pada TRIP tersebut sahaja — semua tarikh yang package itu sah.
			# Row yang nyatakan trip mengkehendaki booking dari trip sama.
			if scope.trip_package and trip_package_name and scope.trip_package == trip_package_name:
				if not scope.trip or not trip_name or scope.trip == trip_name:
					return True
			if scope.group_date and group_date_name and scope.group_date == group_date_name:
				return True
			if (
				scope.trip
				and not scope.group_date
				and not scope.trip_package
				and trip_name
				and scope.trip == trip_name
			):
				return True

		# Legacy: booking tanpa konteks langsung (tiada package/date/trip) —
		# sebarang row scoping trip dianggap padanan.
		if not trip_package_name and not group_date_name and not trip_name:
			return any(s.trip for s in scopings)

		return False
