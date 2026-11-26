# Copyright (c) 2026, WargaPrihatin and contributors
# For license information, please see license.txt

import frappe
from frappe.model.document import Document


class FlightArrangement(Document):
	# begin: auto-generated types
	# This code is auto-generated. Do not modify anything in this block.

	from typing import TYPE_CHECKING

	if TYPE_CHECKING:
		from frappe.types import DF

		from travel_booking.module_trip_management.doctype.flight_arrangement_via.flight_arrangement_via import FlightArrangementVia

		final_destination: DF.Link | None
		flight_mode: DF.Literal["Return", "Multi-City"]
		home_airport: DF.Link
		naming_series: DF.Literal["FA-.YYYY.-.####"]
		notes: DF.SmallText | None
		preferred_airline: DF.Link | None
		travel_package: DF.Link | None
		trip: DF.Link
		via_airports: DF.Table[FlightArrangementVia]
	# end: auto-generated types

	_DOCTYPE_NAME = "Flight Arrangement"

	def validate(self):
		# Return mode mesti ada final destination; Multi-City tak wajibkan
		# (dest akhir ditentukan urutan via).
		if self.flight_mode == "Return" and not self.final_destination:
			frappe.throw("Final Destination diperlukan untuk mode Return.")
		if self.flight_mode == "Multi-City" and self.final_destination:
			frappe.throw("Final Destination hanya untuk mode Return — guna Via Airports untuk Multi-City.")
		# Hierarki ERD: FA peringkat trip = TEMPLATE default; FA dengan
		# travel_package = OVERRIDE eksklusif pakej itu (cth KUL vs SIN).
		# Pakej tidak boleh ada dua override; trip tetap maksimum SATU
		# template (constraint unique:1 lama kini longgar — divalidasi di
		# sini supaya baris override boleh wujud di bawah trip yang sama).
		if self.travel_package:
			pkg_trip = frappe.db.get_value(
				"Travel Package", self.travel_package, "trip")
			if pkg_trip and pkg_trip != self.trip:
				frappe.throw(
					"Travel Package override ({0}) bukan milik trip {1}.".format(
						self.travel_package, self.trip))
			dup = frappe.db.exists("Flight Arrangement", {
				"travel_package": self.travel_package,
				"name": ["!=", self.name],
			})
			if dup:
				frappe.throw(
					"Pakej {0} sudah mempunyai Flight Arrangement override "
					"({1}).".format(self.travel_package, dup))
		else:
			dup = frappe.db.exists("Flight Arrangement", {
				"trip": self.trip,
				"travel_package": ["is", "not set"],
				"name": ["!=", self.name],
			})
			if dup:
				frappe.throw(
					"Trip {0} sudah mempunyai template Flight Arrangement "
					"({1}).".format(self.trip, dup))
