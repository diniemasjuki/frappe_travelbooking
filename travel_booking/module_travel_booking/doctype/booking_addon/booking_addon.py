# Copyright (c) 2026, WargaPrihatin and contributors
# For license information, please see license.txt

import frappe
from frappe.model.document import Document


class BookingAddon(Document):
	# begin: auto-generated types
	# This code is auto-generated. Do not modify anything in this block.

	from typing import TYPE_CHECKING

	if TYPE_CHECKING:
		from frappe.types import DF

		booking: DF.Link
		booking_number: DF.Data | None
		currency: DF.Link | None
		customer: DF.Link | None
		departure_date: DF.Date | None
		naming_series: DF.Literal["BA.YY.MM.###"]
		notes: DF.SmallText | None
		order_date: DF.Datetime | None
		payment_status: DF.Literal["Pending", "Partially Paid", "Paid"]
		return_date: DF.Date | None
		status: DF.Literal["Pending", "Confirmed", "Cancelled"]
		total_amount: DF.Currency
		trip_date: DF.Link | None
		trip_package: DF.Link | None
	# end: auto-generated types

	_DOCTYPE_NAME = "Booking Addon"

	def recompute_total(self):
		"""Jumlah semula dari baris Booking Addon Item (status bukan Cancelled) di
		bawah order ini. Dipanggil oleh Booking Addon Item.refresh_related() setiap
		kali baris ditambah/diubah/dibuang — STORED (bukan virtual/@property)
		supaya total_amount boleh di-List View/Report View/sort macam field
		biasa (rujuk pattern Booking.prog_payment).
		"""
		total = frappe.db.sql("""
			SELECT COALESCE(SUM(amount), 0)
			FROM `tabBooking Addon Item`
			WHERE addon_order = %s AND status != 'Cancelled'
		""", self.name)[0][0]
		frappe.db.set_value("Booking Addon", self.name, "total_amount", total, update_modified=False)

	def refresh_payment_status(self):
		"""Sync payment_status dari SO addon order INI SAHAJA (bukan agregat
		Booking.payment_status, yang termasuk SO cabin lain) — dipanggil dari
		booking_engine._recompute_booking_status() setiap kali Payment Entry
		terhadap sales_order order ini submit/cancel. Bila fully paid, flip
		status Pending -> Confirmed dan Confirmed-kan semua baris Booking Addon Item.
		"""
		if not self.sales_order:
			return

		from travel_booking.api.so_helpers import _compute_payment_status

		so = frappe.db.get_value(
			"Sales Order", self.sales_order, ["grand_total", "advance_paid"], as_dict=True
		)
		if not so:
			return

		new_payment_status = _compute_payment_status(so.advance_paid or 0, float(so.grand_total or 0))
		if new_payment_status != self.payment_status:
			frappe.db.set_value("Booking Addon", self.name, "payment_status", new_payment_status)

		if new_payment_status == "Paid" and self.status == "Pending":
			frappe.db.set_value("Booking Addon", self.name, "status", "Confirmed")
			frappe.db.sql("""
				UPDATE `tabBooking Addon Item`
				SET status = 'Confirmed'
				WHERE addon_order = %s AND status = 'Pending'
			""", self.name)
			# UPGRADE CABIN (Fasa 1B) — order yang mengandungi baris
			# is_cabin_upgrade: apply tukaran kategori bilik pada Booking
			# Reservation sebaik order Confirmed (fully paid). Baris addon
			# biasa no-op. Exception ditangkap supaya status bayaran tetap
			# direkodkan walau apply gagal (admin boleh re-run manual —
			# corak sama _activate_booking).
			try:
				from travel_booking.api.cabin_upgrade import apply_cabin_upgrade_for_order
				apply_cabin_upgrade_for_order(self.name)
			except Exception as e:
				frappe.log_error(
					title="Cabin Upgrade Apply Error",
					message="Booking Addon " + str(self.name) +
					" (booking " + str(self.booking) + "): gagal apply upgrade cabin — " +
					str(e) + ". Status bayaran order tetap Confirmed; semak & " +
					"apply upgrade manual pada Booking Reservation.",
				)