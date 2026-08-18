# Copyright (c) 2026, WargaPrihatin and contributors
# For license information, please see license.txt

import frappe
from frappe.website.website_generator import WebsiteGenerator
from frappe.website.utils import cleanup_page_name

from travel_booking.travel_booking_management.doctype.trip.web_data import get_trip_detail


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

	# Harga pakej & kekosongan seat berubah dari semasa ke semasa (admin
	# kemaskini Trip Package / occupancy) — jangan cache HTML halaman trip;
	# selalu render segar. (Developer mode dah disable cache, flag ni
	# pastikan tingkah laku sama bila site dibawa ke production.)
	no_cache = 1

	# Prefix URL halaman trip — konsisten dengan list page /trips
	# (www/trips.py). Jangan bergantung pada WebsiteGenerator.make_route()
	# — dia guna prefix dari property "route" DocType (nilai semasa
	# "route") yang akan jana URL hodoh /route/<slug>.
	ROUTE_PREFIX = "trips"

	def validate(self):
		# NOTA PENTING (jangan ulang bug lama): JANGAN set self.name di
		# sini. Versi lama call make_autoname() dalam validate() — ia
		# berjalan pada SETIAP save (bukan insert sahaja), jadi name
		# dokumen bertukar setiap kali admin edit Trip dan semua link
		# child (Trip Group Date.trip, Booking, dll) putus. Penamaan
		# series (autoname "naming_series:naming_series") sudah pun
		# dikendalikan oleh Frappe semasa insert — tak perlu override.
		if not self.route:
			self.route = self._default_route()

		# WebsiteGenerator.validate() → set_route(): normalize route
		# (strip / trimmed ke 139 aksara) + is_website_published check.
		super().validate()

	def _default_route(self) -> str:
		"""Route lalai: trips/<slug-trip-name>. Unik — kalau slug dah
		dipakai Trip lain, tambah suffix -2, -3, ... (slug tak semestinya
		unik kerana trip_name boleh jadi sama selepas cleanup)."""
		base = f"{self.ROUTE_PREFIX}/{cleanup_page_name(self.trip_name or self.name)}"
		route, n = base, 2
		while frappe.db.get_value("Trip", {"route": route, "name": ["!=", self.name]}, "name"):
			route = f"{base}-{n}"
			n += 1
		return route

	def get_context(self, context):
		"""Context untuk halaman web /trips/<slug> (templates/trip.html).

		Data (tarikh perlepasan + pakej + harga) disediakan oleh
		web_data.get_trip_detail() — layer query yang SAMA dipakai oleh
		list page /trips, jadi syarat "ready untuk booking" konsisten
		antara kedua-dua halaman.
		"""
		context.update(get_trip_detail(self.name))
		context.no_cache = 1
		context.title = self.trip_name
		context.current_year = frappe.utils.now_datetime().year
		# Breadcrumb (dipakai kalau template extend web.html; template
		# standalone kita buat sendiri breadcrumb dia)
		context.parents = [{"label": "Trips", "route": "/trips"}]
