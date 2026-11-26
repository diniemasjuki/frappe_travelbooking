# Copyright (c) 2026, WargaPrihatin and Contributors
# See license.txt

import frappe
from frappe.model.document import Document


class BookingSalesOrder(Document):
	"""Registri SO milik satu Booking (child table Booking.sales_orders).

	MENGGANTIKAN Sales Order.custom_booking (Nov 2026): arah rujukan
	dibalikkan — Booking memiliki senarai SO-nya; SO tidak lagi memegang
	link ke Booking. Ini membebaskan SO (cancel/delete/reassign) daripada
	sekatan link dua-hala, dan menjadikan split billing / upgrade SO
	(explicit append) lebih dinamik.

	Semua pencarian SO-satu-booking MESTI melalui
	so_helpers._get_all_booking_sales_orders() — jangan query child table
	ini terus dari luar supaya semakan docstatus (exclude Cancelled)
	kekali konsisten."""
	pass
