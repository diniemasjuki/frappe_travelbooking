# Copyright (c) 2026, WargaPrihatin and contributors
# For license information, please see license.txt

import frappe
from frappe.model.document import Document
from frappe.utils import now_datetime


class BookingCancellationRequest(Document):
	# begin: auto-generated types
	# This code is auto-generated. Do not modify anything in this block.
	from typing import TYPE_CHECKING

	if TYPE_CHECKING:
		from frappe.types import DF

		booking: DF.Link
		booking_number: DF.Data | None
		customer: DF.Link | None
		decision_date: DF.Datetime | None
		decision_reason: DF.SmallText | None
		decided_by: DF.Data | None
		naming_series: DF.Literal["BCR.YY.MM.###"]
		reason: DF.SmallText
		requested_at: DF.Datetime | None
		requested_by: DF.Data | None
		status: DF.Literal["Requested", "Approved", "Rejected", "Withdrawn", "Closed"]
	# end: auto-generated types

	_DOCTYPE_NAME = "Booking Cancellation Request"

	def validate(self):
		# Satu permohonan TERBUKA (Requested) sahaja setiap booking —
		# elak pendua bila customer klik berkali-kali / dua laluan.
		if self.status == "Requested":
			open_req = frappe.db.exists(
				"Booking Cancellation Request",
				{"booking": self.booking, "status": "Requested",
				 "name": ["!=", self.name or ""]},
			)
			if open_req:
				frappe.throw(
					"An open cancellation request already exists for this booking "
					"({0}).".format(open_req),
					title="Duplicate Cancellation Request",
				)

		# Booking tak boleh sudah terminal — permohonan atas booking
		# Cancelled/Abandoned tidak bermakna.
		if self.status == "Requested" and self.booking:
			b_status = frappe.db.get_value("Booking", self.booking, "status")
			if b_status in ("Cancelled", "Abandoned"):
				frappe.throw(
					"This booking is already cancelled — no request is needed.",
					title="Booking Already Cancelled",
				)

	def before_insert(self):
		if not self.requested_at:
			self.requested_at = now_datetime()
		if not self.requested_by:
			self.requested_by = frappe.session.user

	def on_update(self):
		# Jejak keputusan: decided_by/date di-stamp bila status berubah
		# kepada keputusan oleh API admin (decide_cancellation_request
		# set medan ni sendiri; jaring keselamatan bila admin edit Desk).
		terminal = ("Approved", "Rejected", "Withdrawn", "Closed")
		if self.status in terminal and not self.decision_date:
			self.db_set("decision_date", now_datetime(), update_modified=False)
