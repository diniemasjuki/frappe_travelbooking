# Copyright (c) 2026, WargaPrihatin and contributors
# For license information, please see license.txt

import frappe
from frappe.model.document import Document
from frappe.model.naming import make_autoname


class Trip(Document):
	# begin: auto-generated types
	# This code is auto-generated. Do not modify anything in this block.

	from typing import TYPE_CHECKING

	if TYPE_CHECKING:
		from frappe.types import DF
		from travel_booking.travel_booking_management.doctype.trip_destination_point_select.trip_destination_point_select import TripDestinationPointSelect
		from travel_booking.travel_booking_management.doctype.trip_itinerary.trip_itinerary import TripItinerary
		from travel_booking.travel_booking_management.doctype.trip_highlight.trip_highlight import TripHighlight
		from travel_booking.travel_booking_management.doctype.trip_feature.trip_feature import TripFeature
		from travel_booking.travel_booking_management.doctype.trip_faq.trip_faq import TripFAQ
		from travel_booking.travel_booking_management.doctype.trip_facility.trip_facility import TripFacility

		description: DF.TextEditor | None
		destination_list: DF.TableMultiSelect[TripDestinationPointSelect]
		facilities: DF.Table[TripFacility]
		faqs: DF.Table[TripFAQ]
		features: DF.Table[TripFeature]
		highlights: DF.Table[TripHighlight]
		is_a_cruise_trip: DF.Check
		itinerary: DF.Table[TripItinerary]
		map_lat: DF.Float
		map_lng: DF.Float
		map_zoom: DF.Int
		naming_series: DF.Literal["TRIP.YY.##"]
		published: DF.Check
		route: DF.Data | None
		status: DF.Literal["Pending Review", "Active", "Completed", "Cancelled"]
		title: DF.Data | None
		trip_categories: DF.Link | None
		trip_image: DF.AttachImage | None
		trip_name: DF.Data
		trip_organizer: DF.Link
	# end: auto-generated types

	_DOCTYPE_NAME = "Trip"

	def get_page_info(self):
		# Dipanggil oleh Frappe DocumentPage renderer kerana Trip ada
		# has_web_view=1. Trip sengaja extend Document (bukan WebsiteGenerator)
		# supaya logik before_save name/route bespoke ("JANGAN USIK") tak
		# terganggu — jadi sediakan hanya page-info minimum yang renderer perlukan.
		title = self.trip_name or self.name
		return frappe._dict(
			doc=self,
			ref_doctype=self.doctype,
			docname=self.name,
			page_title=title,
			title=title,
		)

	def get_context(self, context):
		# Dipanggil DocumentPage renderer untuk page detail /trip/<slug>.
		# Suntik data bersekutu untuk trip NI sahaja:
		#  - booking layer (group dates + packages + starting price +
		#    destinasi) via helper scope-tunggal get_trip_detail
		#  - content layer (gallery, highlights, features incl/excl, faqs,
		#    facilities, map, related tours) dibaca terus dari child tables +
		#    dokumen + tabFile (attachment gallery).
		# Medan dokumen (description, itinerary, trip_organizer,
		# trip_categories) dah masuk context via as_dict().
		import json

		from travel_booking.utils.trip_catalog import get_trip_detail

		d = get_trip_detail(self.name)
		context.group_dates = d["group_dates"]
		context.group_date_groups = d.get("group_date_groups") or []
		context.trip_packages = d["trip_packages"]
		context.starting_from_price = d["starting_from_price"]
		context.destinations = d["destinations"]
		context.is_cruise = d["is_cruise"]
		# JSON untuk widget keberangkatan di JS (select group date -> package
		# -> pricing.get_booking_details). company currency/symbol via kaedah
		# jinja ({{ get_company_symbol() }}) di template.
		context.group_dates_json = json.dumps(d["group_dates"])
		context.trip_packages_json = json.dumps(d["trip_packages"])
		context.trip_image = self.trip_image or "/assets/travel_booking/img/defaultaroyo.jpg"
		# Organizer (Link -> Trip Organizer): papar nama + logo, bukan ID.
		context.organizer_name = (
			frappe.db.get_value("Trip Organizer", self.trip_organizer, "org_name")
			if self.trip_organizer else ""
		)
		context.organizer_logo = (
			frappe.db.get_value("Trip Organizer", self.trip_organizer, "org_logo")
			if self.trip_organizer else ""
		)
		# Itinerary day-by-day: resolve destination_point (Link) ke nama +
		# negara master. Override child rows as_dict dengan dict enriched.
		dp_names = list({
			r.destination_point for r in (self.itinerary or []) if r.destination_point
		})
		dp_map: dict = {}
		if dp_names:
			for dp in frappe.db.get_values(
				"Trip Destination Point", dp_names,
				["name", "destination_name", "destination_country"],
				as_dict=True,
			):
				dp_map[dp.name] = dp
		context.itinerary = [
			{
				"day": r.day,
				"day_title": r.day_title or "",
				"destination_point": r.destination_point or "",
				"destination_name": (dp_map.get(r.destination_point, {}) or {}).get("destination_name") or r.destination_point or "",
				"country": (dp_map.get(r.destination_point, {}) or {}).get("destination_country") or "",
				"meals": r.meals or "",
				"day_image": r.day_image or "",
				"description": r.description or "",
			}
			for r in sorted(self.itinerary or [], key=lambda x: x.day or 0)
		]

		# Gallery: cover (trip_image) + attachment gallery (tabFile, awam
		# sahaja — is_private=0). Jadi slider hero di template; kalau kosong
		# cuma cover dipakai.
		gallery_files = frappe.db.get_all(
			"File",
			filters={"attached_to_doctype": "Trip", "attached_to_name": self.name, "is_private": 0},
			pluck="file_url",
			order_by="creation",
		)
		gallery = []
		if self.trip_image:
			gallery.append(self.trip_image)
		for url in gallery_files:
			if url and url not in gallery:
				gallery.append(url)
		context.gallery = gallery
		context.gallery_json = json.dumps(gallery)

		# Highlights — bullet ringkas.
		context.highlights = [
			{"highlight": r.highlight or ""}
			for r in (self.highlights or [])
		]

		# Features: satu child table, pecah ikut flag `included` -> dua
		# senarai (Include / Exclude) di template.
		included, excluded = [], []
		for r in (self.features or []):
			item = {"feature": r.feature or ""}
			(included if r.included else excluded).append(item)
		context.included = included
		context.excluded = excluded

		# FAQ.
		context.faqs = [
			{"question": r.question or "", "answer": r.answer or ""}
			for r in (self.faqs or [])
		]

		# Facilities (amenities + ikon Tabler).
		context.facilities = [
			{"facility": r.facility or "", "icon": r.icon or ""}
			for r in (self.facilities or [])
		]

		# Travel styles: reuse field sedia ada — tag cruise + item group.
		styles = []
		if self.is_a_cruise_trip:
			styles.append({"name": "Cruise"})
		if self.trip_categories:
			styles.append({"name": self.trip_categories})
		context.travel_styles = styles

		# Location map (lat/lng pada Trip). has_map = False kalau tiada koordinat.
		context.map_lat = float(self.map_lat or 0)
		context.map_lng = float(self.map_lng or 0)
		context.map_zoom = int(self.map_zoom or 8)
		context.has_map = bool(self.map_lat and self.map_lng)

		# Related tours — sama trip_categories, isi dgn trip lain jika kurang.
		context.related = self._related_tours(limit=4)

		context.no_cache = 1
		context.active_nav = "trips"

	def _related_tours(self, limit=4):
		# Trip berkaitan: sama trip_categories (Item Group); kalau kurang dari
		# `limit`, isi dengan trip Active+published lain (eksklusif diri).
		cat = self.trip_categories
		rows: list = []
		if cat:
			rows = frappe.db.sql(
				"""
				SELECT t.name, t.trip_name, t.route, t.trip_image, t.is_a_cruise_trip
				FROM `tabTrip` t
				WHERE t.name != %(me)s AND t.status='Active' AND t.published=1
				  AND t.trip_categories = %(cat)s
				ORDER BY t.trip_name
				LIMIT {lim}
				""".format(lim=int(limit)),
				{"me": self.name, "cat": cat},
				as_dict=True,
			)
		if len(rows) < limit:
			excl = [r.name for r in rows] + [self.name]
			rest = limit - len(rows)
			more = frappe.db.sql(
				"""
				SELECT t.name, t.trip_name, t.route, t.trip_image, t.is_a_cruise_trip
				FROM `tabTrip` t
				WHERE t.name NOT IN %(ex)s AND t.status='Active' AND t.published=1
				ORDER BY t.trip_name
				LIMIT {lim}
				""".format(lim=int(rest)),
				{"ex": excl},
				as_dict=True,
			)
			rows += more
		# Harga terendah "from" setiap related trip (satu query berkelompok).
		if rows:
			price_map = {
				r["trip"]: r["mn"]
				for r in frappe.db.sql(
					"""
					SELECT tp.trip_link AS trip, MIN(pr.price_adult) AS mn
					FROM `tabTrip Package` tp
					JOIN `tabTrip Package Price` pr ON pr.parent = tp.name
					WHERE tp.trip_link IN %(names)s AND tp.status='Active'
					GROUP BY tp.trip_link
					""",
					{"names": [r.name for r in rows]},
					as_dict=True,
				)
			}
			for r in rows:
				r["trip_image"] = r.trip_image or "/assets/travel_booking/img/defaultaroyo.jpg"
				r["starting_from_price"] = (
					float(price_map[r.name]) if r.name in price_map and price_map[r.name] else None
				)
		return rows

	def autoname(self):
		# Naming siri TRIP.YY.## — Frappe panggil ini sekali semasa insert
		# (via set_new_name), selepas reset self.name. Override config/Property
		# Setter → jamin siri. Tak dipanggil semasa update, jadi name stabil.
		self.name = make_autoname(self.naming_series)

	def before_save(self):
		self.title = self.trip_name.upper()
		self.route = "trip/" + self.trip_name.lower().replace(" ", "-")

	def validate(self):
		pass
		
