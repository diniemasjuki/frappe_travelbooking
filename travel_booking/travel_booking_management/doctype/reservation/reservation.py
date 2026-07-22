# Copyright (c) 2026, WargaPrihatin and contributors
# For license information, please see license.txt

import frappe
from frappe.model.document import Document


class Reservation(Document):
	# begin: auto-generated types
	# This code is auto-generated. Do not modify anything in this block.

	from typing import TYPE_CHECKING

	if TYPE_CHECKING:
		from frappe.types import DF

		aroya_guest_no: DF.Int
		booking: DF.Link | None
		delegate_no: DF.Data | None
		document_status: DF.Literal["Pending", "Verified", "Open for Update", "Rejected"]
		flight: DF.Link | None
		full_name: DF.Data | None
		nationality: DF.Data | None
		passport_expiry: DF.Data | None
		passport_no: DF.Data | None
		room_category: DF.Link | None
		slot_label: DF.Data | None
		stateroom_no: DF.Data | None
		status: DF.Literal["Confirmed", "Cancelled"]
		traveller: DF.Link | None
	# end: auto-generated types

	_DOCTYPE_NAME = "Reservation"

	def before_insert(self):
		self.set_slot_label()

	def after_insert(self):
		self.refresh_related()

	def on_update(self):
		self.refresh_related()

	def on_trash(self):
		self.refresh_related()

	def set_slot_label(self):
		"""Auto 'Traveller N' ikut turutan dalam booking."""
		if self.slot_label:
			return
		existing = frappe.db.count("Reservation", {"booking": self.booking})
		self.slot_label = "Traveller " + str(existing + 1)

	def refresh_related(self):
		"""Update Trip Date & Flight yang berkaitan."""
		old = self.get_doc_before_save()

		# --- Trip Date (via Booking) ---
		trip_date = frappe.db.get_value("Booking", self.booking, "trip_date")
		if trip_date:
			frappe.get_doc("Trip Date", trip_date).refresh_bookings()

		# --- Flight ---
		if self.flight:
			frappe.get_doc("Flight", self.flight).refresh_seats()
		if old and old.flight and old.flight != self.flight:
			frappe.get_doc("Flight", old.flight).refresh_seats()
