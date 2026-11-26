# Copyright (c) 2026, WargaPrihatan and contributors
# For license information, please see license.txt

import frappe
from frappe.model.document import Document


class CruiseCabin(Document):
	# begin: auto-generated types
	# This code is auto-generated. Do not modify anything in this block.

	from typing import TYPE_CHECKING

	if TYPE_CHECKING:
		from frappe.types import DF

		bed_type: DF.Data | None
		deck: DF.Int | None
		notes: DF.SmallText | None
		room_category: DF.Link
		room_no: DF.Data
		schedule: DF.Link
		status: DF.Literal["Available", "Blocked", "Assigned", "Maintenance"]
	# end: auto-generated types

	_DOCTYPE_NAME = "Cruise Cabin"

	def validate(self):
		self.validate_category_on_schedule()
		self.sync_status_from_reservations()

	def validate_category_on_schedule(self):
		"""Room category SEBAIKNYA wujud dalam cabin_rates schedule supaya
		registry dan inventori harga konsisten. TAPI registry ialah data
		FIZIKAL (bilik wujud walau harga belum dikonfigurasi) — jadikan
		amaran sahaja, bukan halangan; admin boleh isi rate kemudian.
		Overview registry (get_registry_overview) akan tonjolkan kategori
		tanpa allotment untuk tindakan susulan."""
		exists = frappe.db.exists(
			"Trip Package Price",
			{"parent": self.schedule, "parenttype": "Trip Cruise Schedule",
			 "pricing_for_class": self.room_category},
		)
		if not exists:
			frappe.msgprint(
				"Room Category '{0}' is not in the cabin rates of schedule "
				"{1}. Add it to the schedule's cabin rates so allotment "
				"matches the registry.".format(
					self.room_category, self.schedule),
				indicator="orange", alert=True,
			)

	def sync_status_from_reservations(self):
		"""Status Assigned ↔ Available dikira dari Booking Reservation
		yang menempah bilik fizikal ini (stateroom_no = room_no pada
		schedule sama, status bukan Cancelled). Maintenance/Blocked kekal
		manual — admin override yang tidak ditulis balik automatik."""
		if self.status in ("Maintenance", "Blocked"):
			return
		assigned = frappe.db.count("Booking Reservation", {
			"trip_cruise_schedule": self.schedule,
			"stateroom_no": self.room_no,
			"status": ["!=", "Cancelled"],
		})
		new_status = "Assigned" if assigned else "Available"
		if self.status != new_status:
			self.status = new_status
