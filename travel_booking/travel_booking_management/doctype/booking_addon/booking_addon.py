# Copyright (c) 2026, WargaPrihatin and contributors
# For license information, please see license.txt

import frappe
from frappe.model.document import Document
from frappe.utils import add_days, getdate


class BookingAddon(Document):
	# begin: auto-generated types
	# This code is auto-generated. Do not modify anything in this block.

	from typing import TYPE_CHECKING

	if TYPE_CHECKING:
		from frappe.types import DF

		addon: DF.Link | None
		addon_order: DF.Link
		addon_package: DF.Link
		addon_title: DF.Data | None
		amount: DF.Currency
		booking: DF.Link | None
		booking_reservation: DF.Link | None
		currency: DF.Link | None
		customer: DF.Link | None
		departure_date: DF.Date | None
		naming_series: DF.Literal["BA.YY.MM.###"]
		notes: DF.SmallText | None
		qty: DF.Int
		sales_order: DF.Link | None
		scope: DF.Literal["Per Booking", "Per Pax"]
		status: DF.Literal["Pending", "Confirmed", "Cancelled"]
		traveller_name: DF.Data | None
		trip_date: DF.Link | None
		trip_package: DF.Link | None
		unit_price: DF.Currency
		valid_from: DF.Date | None
		valid_to: DF.Date | None
	# end: auto-generated types

	_DOCTYPE_NAME = "Booking Addon"

	def before_insert(self):
		self.snapshot_pricing()
		self.snapshot_validity()

	def validate(self):
		self.enforce_scope()
		self.recompute_amount()
		self.validate_limits()

	def after_insert(self):
		self.refresh_related()

	def on_update(self):
		self.refresh_related()

	def on_trash(self):
		self.refresh_related()

	def snapshot_pricing(self):
		"""Bekukan currency + unit_price dari Addon Package WAKTU baris ini
		dicipta sahaja (before_insert, bukan validate) — perubahan harga
		Addon Package selepas ni tak menjejaskan baris sedia ada.
		"""
		if not self.addon_package:
			return
		ap = frappe.db.get_value(
			"Trip Addon Package", self.addon_package, ["currency", "unit_price"], as_dict=True
		)
		if ap:
			self.currency = ap.currency
			self.unit_price = ap.unit_price

	def snapshot_validity(self):
		"""Kira valid_from/valid_to dari validity_mode Addon Package + tarikh
		trip SEMASA baris ini dicipta, kemudian BEKUKAN (tak dikira semula
		lepas ni, walaupun offering/trip date diubah admin kemudian).
		"""
		if not self.addon_package:
			return
		ap = frappe.db.get_value(
			"Trip Addon Package",
			self.addon_package,
			["validity_mode", "valid_from_offset_days", "valid_to_offset_days",
			 "fixed_valid_from", "fixed_valid_to"],
			as_dict=True,
		)
		if not ap:
			return

		departure = self.departure_date
		return_date = None
		if self.addon_order:
			return_date = frappe.db.get_value("Booking Addon Order", self.addon_order, "return_date")

		if ap.validity_mode == "Fixed Dates":
			self.valid_from = ap.fixed_valid_from
			self.valid_to = ap.fixed_valid_to
		elif ap.validity_mode == "Relative to Departure" and departure:
			self.valid_from = add_days(departure, ap.valid_from_offset_days or 0)
			self.valid_to = add_days(departure, ap.valid_to_offset_days or 0)
		else:
			# "Same as Trip" (default) — ikut tarikh berlepas/pulang trip terus.
			self.valid_from = departure
			self.valid_to = return_date or departure

	def enforce_scope(self):
		"""Per Pax mesti ada booking_reservation MILIK booking yang sama.
		Per Booking mesti KOSONG booking_reservation — elak baris tertinggal
		rujukan traveller yang tak relevan bila scope sebenarnya di peringkat
		booking.
		"""
		if self.scope == "Per Pax":
			if not self.booking_reservation:
				frappe.throw("Booking Reservation is required when Scope is Per Pax.")
			res_booking = frappe.db.get_value("Booking Reservation", self.booking_reservation, "booking")
			if res_booking != self.booking:
				frappe.throw("The selected Booking Reservation does not belong to this booking.")
		else:
			self.booking_reservation = None

	def recompute_amount(self):
		"""amount = unit_price (dibekukan) x qty. qty boleh diubah admin
		selepas cipta (contoh pembetulan manual) — unit_price/currency/
		validity KEKAL beku, hanya amount yang recalculate ikut qty terkini.
		"""
		self.amount = float(self.unit_price or 0) * int(self.qty or 0)

	def validate_limits(self):
		"""Jaring keselamatan peringkat doctype — semakan UTAMA sepatutnya
		dah berlaku di api/addon_manager.checkout_addons() (server-side,
		sebelum baris dicipta), tapi ni jalan automatik tak kira laluan
		(portal ATAU admin isi terus di Desk), ikut pattern
		Booking Reservation.validate_cabin_capacity().
		"""
		if not self.addon_package:
			return
		ap = frappe.db.get_value(
			"Trip Addon Package", self.addon_package, ["max_qty_per_booking", "max_total_qty", "current_qty_sold"],
			as_dict=True,
		)
		if not ap:
			return

		if ap.max_qty_per_booking:
			existing = frappe.db.sql("""
				SELECT COALESCE(SUM(qty), 0)
				FROM `tabBooking Addon`
				WHERE addon_package = %s AND booking = %s AND status != 'Cancelled'
				  AND name != %s
			""", (self.addon_package, self.booking, self.name or ""))[0][0]
			if (existing + int(self.qty or 0)) > ap.max_qty_per_booking:
				frappe.throw(
					"Maximum quantity per booking (" + str(ap.max_qty_per_booking) +
					") exceeded for this addon."
				)

		if ap.max_total_qty:
			already_counted = ap.current_qty_sold if self.status != "Cancelled" and not self.is_new() else 0
			projected = ap.current_qty_sold - already_counted + int(self.qty or 0)
			if projected > ap.max_total_qty:
				frappe.throw("This addon has reached its maximum total quantity available.")

	def refresh_related(self):
		"""Kemas kini current_qty_sold (Addon Package) dan total_amount
		(Booking Addon Order) — dipanggil selepas setiap insert/update/trash
		supaya kedua-dua field agregat tu sentiasa terkini (stored, bukan
		virtual — rujuk nota di Addon Package/Booking Addon Order).
		"""
		if self.addon_package:
			sold = frappe.db.sql("""
				SELECT COALESCE(SUM(qty), 0)
				FROM `tabBooking Addon`
				WHERE addon_package = %s AND status != 'Cancelled'
			""", self.addon_package)[0][0]
			frappe.db.set_value("Trip Addon Package", self.addon_package, "current_qty_sold", sold, update_modified=False)

		if self.addon_order:
			frappe.get_doc("Booking Addon Order", self.addon_order).recompute_total()