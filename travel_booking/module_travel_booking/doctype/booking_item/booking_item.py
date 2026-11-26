# Copyright (c) 2026, WargaPrihatin and contributors
# For license information, please see license.txt

import frappe
from frappe.model.document import Document


class BookingItem(Document):
	# begin: auto-generated types
	# This code is auto-generated. Do not modify anything in this block.
	from typing import TYPE_CHECKING

	if TYPE_CHECKING:
		from frappe.types import DF

		booking: DF.Link
		cabin_no: DF.Int
		currency: DF.Link | None
		passport_link_email: DF.Data | None
		passport_link_expires_on: DF.Datetime | None
		passport_link_token: DF.Data | None
		pax_type: DF.Data
		rate_basis: DF.Literal["Standard", "Single", "Additional"]
		room_category: DF.Link
		room_privacy: DF.Literal["Private", "Open Sharing"] | None
		sales_order: DF.Link | None
		status: DF.Literal["Active", "Cancelled"]
		traveller: DF.Link | None
		unit_price: DF.Currency
	# end: auto-generated types

	_DOCTYPE_NAME = "Booking Item"

	def validate(self):
		# Fasa 0 (booking-centric): baris komersial per traveller — sumber
		# struktur tunggal booking ( Booking Item → SO / Reservation dijana
		# daripadanya). Kawalan ringkas sahaja di sini; pembentukan baris
		# dikawal oleh _write_booking_items/_build_item_specs di
		# api/so_helpers.py — kaunter kuota/seat KEKAL baca Booking
		# Reservation, jadual ini tidak pernah dikira untuk kapasiti.
		if self.status == "Cancelled":
			# Baris hangus (Fasa 1: edit booking) — jangan ganggu apa-apa
			# agregat; pembaca sedia ada menapis status != 'Cancelled'.
			return
		if not self.pax_type:
			frappe.throw("Pax type is required on Booking Item.")
		if self.unit_price is None:
			frappe.throw("Unit price is required on Booking Item.")
