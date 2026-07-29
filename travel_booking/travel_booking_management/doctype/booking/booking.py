# Copyright (c) 2026, WargaPrihatin and contributors
# For license information, please see license.txt

import frappe
from frappe.model.document import Document


class Booking(Document):
	# begin: auto-generated types
	# This code is auto-generated. Do not modify anything in this block.

	from typing import TYPE_CHECKING

	if TYPE_CHECKING:
		from frappe.types import DF

		affiliate: DF.Link | None
		booking_number: DF.Data
		customer: DF.Link | None
		deposit_amount: DF.Currency
		payment_method: DF.Literal["Online Payment", "Manual Transfer"]
		payment_status: DF.Literal["Pending", "Partially Paid", "Paid", "Request Refund", "Pending Refund", "Refunded"]
		payment_type: DF.Literal["Full Payment", "Deposit"]
		pre_discount_total: DF.Currency
		referral_code_used: DF.Data | None
		status: DF.Literal["Pending", "Processing", "Accepted", "Confirmed", "Completed", "Cancelled"]
		trip_date: DF.Link | None
		trip_name: DF.Link | None
		trip_package: DF.Link | None
	# end: auto-generated types

	_DOCTYPE_NAME = "Booking"

	
	@property
	def total_amount(self):
		"""Jumlah keseluruhan (SEMUA SO — utama + addon) berkaitan booking ni."""
		from travel_booking.api.booking import _get_all_booking_sales_orders
		total = 0
		for so_name in _get_all_booking_sales_orders(self.name):
			total += frappe.db.get_value("Sales Order", so_name, "grand_total") or 0
		return total

	@property
	def balance_amount(self):
		"""Baki tertunggak (SEMUA SO — utama + addon) berkaitan booking ni."""
		from travel_booking.api.booking import _get_all_booking_sales_orders
		total = 0
		paid  = 0
		for so_name in _get_all_booking_sales_orders(self.name):
			so = frappe.db.get_value("Sales Order", so_name, ["grand_total", "advance_paid"], as_dict=True)
			if so:
				total += so.grand_total  or 0
				paid  += so.advance_paid or 0
		return max(0, total - paid)

	@property
	def order_summary(self):
		"""Apa yang customer beli — SO UTAMA sahaja (cabin booking asal),
		BUKAN addon (excursion dll dipaparkan berasingan sebagai 'Add-ons').
		"""
		from travel_booking.api.booking import _get_primary_so
		primary_so = _get_primary_so(self.name)
		if not primary_so:
			return ""
		items = frappe.db.get_all("Sales Order Item",
									filters={"parent": primary_so},
									fields=["item_name", "qty"], order_by="idx")
		if not items:
			return ""
		return "\n".join(
			(it.item_name or "") + "  \u00d7  " + str(int(it.qty or 0)) for it in items
		)

	@property
	def total_pax(self):
		return frappe.db.count("Booking Reservation", {"booking": self.name, "status": "Confirmed"})

	@property
	def verified_pax(self):
		return frappe.db.count("Booking Reservation", {"booking": self.name, "status": "Confirmed", "document_status": "Verified"})

	@property
	def pending_pax(self):
		return frappe.db.count("Booking Reservation", {"booking": self.name, "status": "Confirmed", "document_status": "Pending"})