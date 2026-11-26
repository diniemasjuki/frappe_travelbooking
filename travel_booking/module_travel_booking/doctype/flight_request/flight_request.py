# Copyright (c) 2026, WargaPrihatan and contributors
# For license information, please see license.txt

import frappe
from frappe.model.document import Document


class FlightRequest(Document):
	# begin: auto-generated types
	# This code is auto-generated. Do not modify anything in this block.

	from typing import TYPE_CHECKING

	if TYPE_CHECKING:
		from frappe.types import DF

		booking: DF.Link | None
		departure_date: DF.Date | None
		destination_airport: DF.Link | None
		flight: DF.Link | None
		flight_class: DF.Literal["Economy", "Economy Plus", "Premium Economy", "Business Class", "First Class"]
		notes: DF.TextEditor | None
		origin_airport: DF.Link | None
		pax_count: DF.Int | None
		priority: DF.Literal["Normal", "High", "Urgent"]
		request_title: DF.Data | None
		requested_by: DF.Link | None
		return_date: DF.Date | None
		status: DF.Literal["Requested", "Quoted", "Booked", "Fulfilled", "Cancelled"]
		ticket_type: DF.Literal["FIT", "GIT"]
		trip_package: DF.Link | None
	# end: auto-generated types

	_DOCTYPE_NAME = "Flight Request"

	def validate(self):
		self.autofill_from_context()
		self.autofill_request_title()
		self.validate_flight_link_status()

	def autofill_from_context(self):
		"""Tarik konteks trip daripada Booking/Trip Package yang dirujuk —
		pax count, tarikh perjalanan, dan requested_by default user semasa.
		Nilai eksplisit (admin isi sendiri) tidak ditindih."""
		if not self.requested_by:
			self.requested_by = frappe.session.user

		if self.booking:
			b = frappe.db.get_value(
				"Booking", self.booking,
				["booked_pax", "trip_package", "trip_date"], as_dict=True)
			if b:
				if not self.trip_package and b.trip_package:
					self.trip_package = b.trip_package
				if not self.pax_count and b.booked_pax:
					self.pax_count = b.booked_pax
				if not self.departure_date and b.trip_date:
					dep = frappe.db.get_value(
						"Trip Group Date", b.trip_date, "departure_date")
					if dep:
						self.departure_date = dep
		elif self.trip_package and not self.departure_date:
			# Tiada booking — tarikh departure pertama pakej.
			gd = frappe.db.sql("""
				SELECT tgd.departure_date
				FROM `tabTrip Package Group Date Select` s
				JOIN `tabTrip Group Date` tgd ON tgd.name = s.trip_group_date
				WHERE s.parent = %s AND s.parenttype = 'Trip Package'
				ORDER BY tgd.departure_date ASC LIMIT 1
			""", self.trip_package)
			if gd and gd[0][0]:
				self.departure_date = gd[0][0]

	def autofill_request_title(self):
		"""Title mesra senarai: 'FIT — Economy — KUL → LGK — 2026-11-15 — 3 pax'."""
		if self.request_title:
			return
		parts = []
		if self.ticket_type:
			parts.append(self.ticket_type)
		if self.flight_class:
			parts.append(self.flight_class)
		route = ""
		if self.origin_airport:
			code = frappe.db.get_value("Flight Airport", self.origin_airport, "airport_code")
			route = (code or self.origin_airport)
		if self.destination_airport:
			code = frappe.db.get_value("Flight Airport", self.destination_airport, "airport_code")
			dest = code or self.destination_airport
			route = route + " → " + dest if route else dest
		if route:
			parts.append(route)
		if self.departure_date:
			parts.append(str(self.departure_date))
		if self.pax_count:
			parts.append(str(self.pax_count) + " pax")
		self.request_title = " — ".join(parts) if parts else "Flight Request"

	def validate_flight_link_status(self):
		"""Flight fulfilment hanya dibenarkan bila status Booked/Fulfilled —
		elak link flight pada request yang masih Requested (lupa quote)."""
		if self.flight and self.status in ("Requested", "Quoted"):
			frappe.msgprint(
				"Flight is linked but status is still '{0}'. Set status to "
				"'Booked' to reflect the fulfilment.".format(self.status),
				indicator="orange", alert=True,
			)
