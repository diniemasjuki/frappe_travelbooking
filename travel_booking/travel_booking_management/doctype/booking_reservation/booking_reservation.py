# Copyright (c) 2026, WargaPrihatin and contributors
# For license information, please see license.txt

import frappe
from frappe.model.document import Document


class BookingReservation(Document):
	# begin: auto-generated types
	# This code is auto-generated. Do not modify anything in this block.

	from typing import TYPE_CHECKING

	if TYPE_CHECKING:
		from frappe.types import DF

		aroya_guest_no: DF.Int
		arrival_date: DF.Data | None
		booking: DF.Link | None
		cruise_end: DF.Data | None
		cruise_start: DF.Data | None
		date_selection: DF.Link | None
		delegate_no: DF.Data | None
		departure_date: DF.Data | None
		departure_point: DF.Data | None
		document_status: DF.Literal["Pending", "Verified", "Open for Update", "Rejected"]
		flight: DF.Link | None
		full_name: DF.Data | None
		guest_label: DF.Data | None
		is_a_cruise: DF.Check
		package_title: DF.Data | None
		package_type: DF.Data | None
		room_category: DF.Link | None
		stateroom_no: DF.Data | None
		status: DF.Literal["Pending Review", "Confirmed", "Cancelled"]
		traveller: DF.Link | None
		trip_link: DF.Data | None
		trip_name: DF.Data | None
		trip_organizer: DF.Data | None
		trip_package: DF.Link | None
		trip_package_code: DF.Data | None
	# end: auto-generated types

	_DOCTYPE_NAME = "Booking Reservation"

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
		if self.guest_label:
			return
		existing = frappe.db.count("Booking Reservation", {"booking": self.booking})
		self.guest_label = "Traveller " + str(existing + 1)

	def refresh_related(self):
		"""Update Trip Group Date & Flight yang berkaitan."""
		old = self.get_doc_before_save()

		# --- Trip Group Date (via Booking) ---
		trip_group_date = frappe.db.get_value("Booking", self.booking, "trip_date")
		if trip_group_date:
			frappe.get_doc("Trip Group Date", trip_group_date).refresh_bookings()

		# --- Flight ---
		if self.flight:
			frappe.get_doc("Flight", self.flight).refresh_seats()
		if old and old.flight and old.flight != self.flight:
			frappe.get_doc("Flight", old.flight).refresh_seats()