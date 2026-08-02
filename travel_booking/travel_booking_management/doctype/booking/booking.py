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
		cruise_end: DF.Date | None
		cruise_start: DF.Date | None
		cust_email: DF.Data | None
		customer: DF.Link | None
		departure_date: DF.Date | None
		is_a_cruise_trip: DF.Check
		is_cruise_only: DF.Check
		naming_series: DF.Literal["BOOK.YY.MM.###"]
		payment_status: DF.Literal["Pending", "Partially Paid", "Paid", "Request Refund", "Pending Refund", "Refunded"]
		pre_discount_total: DF.Currency
		prog_payment: DF.Percent
		referral_code_used: DF.Data | None
		return_date: DF.Date | None
		status: DF.Literal["Pending", "Processing", "Accepted", "Confirmed", "Completed", "Abandoned", "Cancelled"]
		trip_date: DF.Link | None
		trip_date_group_status: DF.ReadOnly | None
		trip_name: DF.Link | None
		trip_package: DF.Link | None
		trip_package_status: DF.ReadOnly | None
		trip_status: DF.ReadOnly | None
	# end: auto-generated types

	_DOCTYPE_NAME = "Booking"

	
	@property
	def cust_phone(self):
		"""Phone customer TERKINI — dikira on-the-fly dari Customer (link
		field 'customer' di atas) -> Contact (melalui Dynamic Link), BUKAN
		snapshot yang disimpan semasa booking dicipta. Kalau customer
		update phone mereka kemudian (cth via portal), field ni terus
		ikut nilai TERKINI — elak data 'stale'/tak segerak dengan Contact
		sebenar. Guna get_customer_phone() (_helpers.py) — sumber
		kebenaran YANG SAMA dipakai send_otp() untuk auto-fill wizard.
		"""
		from travel_booking.api._helpers import get_customer_phone
		if not self.customer:
			return ""
		return get_customer_phone(self.customer) or ""

	@property
	def cust_email(self):
		"""Email customer TERKINI — sama prinsip dengan cust_phone di atas,
		dikira dari Customer -> Contact (Dynamic Link), bukan snapshot.
		"""
		from travel_booking.api._helpers import get_customer_email
		if not self.customer:
			return ""
		return get_customer_email(self.customer) or ""

	@property
	def total_amount(self):
		"""Jumlah keseluruhan (SEMUA SO — utama + addon) berkaitan booking ni."""
		from travel_booking.api.booking import _get_all_booking_sales_orders
		total = 0
		for so_name in _get_all_booking_sales_orders(self.name):
			so = frappe.db.get_value("Sales Order", so_name, ["grand_total", "rounded_total"], as_dict=True)
			if so:
				# rounded_total diutamakan (fallback grand_total) — sepadan
				# dengan nilai yang customer nampak/bayar sebenarnya, bukan
				# jumlah mentah sebelum ERPNext bundarkan.
				total += float(so.rounded_total or so.grand_total or 0)
		return total

	@property
	def balance_amount(self):
		"""Baki tertunggak (SEMUA SO — utama + addon) berkaitan booking ni."""
		from travel_booking.api.booking import _get_all_booking_sales_orders
		total = 0
		paid  = 0
		for so_name in _get_all_booking_sales_orders(self.name):
			so = frappe.db.get_value("Sales Order", so_name, ["grand_total", "rounded_total", "advance_paid"], as_dict=True)
			if so:
				total += float(so.rounded_total or so.grand_total or 0)
				paid  += so.advance_paid or 0
		return max(0, total - paid)

	@property
	def order_summary(self):
		"""Apa yang customer beli — SO UTAMA sahaja (cabin booking asal),
		BUKAN addon (excursion dll dipaparkan berasingan sebagai 'Add-ons').

		Format cermin 'Payment Summary' pada wizard booking (booking.js:
		buildOrderSummary()/buildStep1Summary()) — dikumpul ikut CABIN,
		dengan 'Cabin Fare' (jumlah) + pecahan 'Guest N: [label] — RM x'
		setiap orang, bukan sekadar senarai rata 'item_name x qty'
		seperti sebelum ini. Guest numbering reset setiap cabin baharu,
		sama pattern dengan wizard.
		"""
		from travel_booking.api.booking import _get_primary_so
		primary_so = _get_primary_so(self.name)
		if not primary_so:
			return ""

		items = frappe.db.get_all("Sales Order Item",
									filters={"parent": primary_so},
									fields=["item_name", "qty", "rate"], order_by="idx")
		if not items:
			return ""

		# Kumpul ikut cabin — bahagian SEBELUM em dash (\u2014) dalam
		# item_name (cth "Balcony Cabin (Cabin 1)"), sepadan format
		# _so_line() dalam api/booking.py yang cipta baris SO ni.
		cabins    = []
		cabin_map = {}

		for it in items:
			name = it.item_name or ""
			if "\u2014" in name:
				cabin_label, pax_type = name.split("\u2014", 1)
				cabin_label = cabin_label.strip()
				pax_type    = pax_type.strip()
			else:
				cabin_label, pax_type = name, ""

			if cabin_label not in cabin_map:
				cabin_map[cabin_label] = {"label": cabin_label, "fare": 0.0, "lines": []}
				cabins.append(cabin_map[cabin_label])

			qty  = int(it.qty or 0)
			rate = float(it.rate or 0)
			cabin_map[cabin_label]["fare"] += qty * rate
			for _ in range(qty):
				cabin_map[cabin_label]["lines"].append((pax_type, rate))

		out = []
		for c in cabins:
			out.append(c["label"])
			out.append("  Cabin Fare: RM {:,.2f}".format(c["fare"]))
			for i, (pax_type, rate) in enumerate(c["lines"], start=1):
				out.append("  Guest {}: {} \u2014 RM {:,.2f}".format(i, pax_type, rate))
			out.append("")  # baris kosong antara cabin, macam kad berasingan di wizard

		return "\n".join(out).rstrip()

	@property
	def total_pax(self):
		return frappe.db.count("Booking Reservation", {"booking": self.name, "status": "Confirmed"})

	@property
	def verified_pax(self):
		return frappe.db.count("Booking Reservation", {"booking": self.name, "status": "Confirmed", "document_status": "Verified"})

	@property
	def pending_pax(self):
		return frappe.db.count("Booking Reservation", {"booking": self.name, "status": "Confirmed", "document_status": "Pending"})