# Copyright (c) 2026, WargaPrihatin and contributors
# For license information, please see license.txt

import frappe
from frappe.model.naming import make_autoname
from frappe.website.website_generator import WebsiteGenerator


class Trip(WebsiteGenerator):
	# begin: auto-generated types
	# This code is auto-generated. Do not modify anything in this block.

	from typing import TYPE_CHECKING

	if TYPE_CHECKING:
		from frappe.types import DF
		from travel_booking.travel_booking_management.doctype.trip_destination_point_select.trip_destination_point_select import TripDestinationPointSelect

		description: DF.TextEditor | None
		destination_list: DF.TableMultiSelect[TripDestinationPointSelect]
		is_a_cruise_trip: DF.Check
		naming_series: DF.Literal["TRIP.YY.##"]
		published: DF.Check
		route: DF.Data | None
		status: DF.Literal["Pending Review", "Active", "Completed", "Cancelled"]
		trip_image: DF.AttachImage | None
		trip_name: DF.Data
		trip_organizer: DF.Link
	# end: auto-generated types

	_DOCTYPE_NAME = "Trip"

	def validate(self):
		# NOTA PENTING (jangan ulang bug lama): JANGAN set self.name di
		# sini. Versi lama call make_autoname() dalam validate() — ia
		# berjalan pada SETIAP save (bukan insert sahaja), jadi name
		# dokumen bertukar setiap kali admin edit Trip dan semua link
		# child (Trip Group Date.trip, Booking, dll) putus. Penamaan
		# series (autoname "naming_series:naming_series") sudah pun
		# dikendalikan oleh Frappe semasa insert — tak perlu override.

		# JANGAN USIK, INI UNTUK SET TRIP CODE YANG PENTING
		self.name = make_autoname(self.naming_series)

		# WebsiteGenerator.validate() → set_route(): normalize route
		# (strip / trimmed ke 139 aksara) + is_website_published check.
		super().validate()
