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
		from travel_booking.travel_booking_management.doctype.trip_facility.trip_facility import TripFacility
		from travel_booking.travel_booking_management.doctype.trip_faq.trip_faq import TripFAQ
		from travel_booking.travel_booking_management.doctype.trip_feature.trip_feature import TripFeature
		from travel_booking.travel_booking_management.doctype.trip_highlight.trip_highlight import TripHighlight
		from travel_booking.travel_booking_management.doctype.trip_itinerary.trip_itinerary import TripItinerary

		description: DF.TextEditor | None
		destination_list: DF.TableMultiSelect[TripDestinationPointSelect]
		facilities: DF.Table[TripFacility]
		faqs: DF.Table[TripFAQ]
		features: DF.Table[TripFeature]
		highlights: DF.Table[TripHighlight]
		is_a_cruise_trip: DF.Check
		itinerary: DF.Table[TripItinerary]
		logo_organizer: DF.AttachImage | None
		naming_series: DF.Literal["TRIP.YY.##"]
		published: DF.Check
		route: DF.Data | None
		status: DF.Literal["Pending Review", "Active", "Completed", "Cancelled"]
		title: DF.Data | None
		trip_image: DF.AttachImage | None
		trip_name: DF.Data
		trip_organizer: DF.Link
		video_url: DF.Data | None
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
		group_dates_raw = d["group_dates"]
		is_cruise = d["is_cruise"]

		context.group_dates = group_dates_raw
		context.group_date_groups = d.get("group_date_groups") or []
		context.trip_packages = d["trip_packages"]
		context.starting_from_price = d["starting_from_price"]
		context.destinations = d["destinations"]
		context.is_cruise = d["is_cruise"]
		# JSON untuk widget keberangkatan di JS (select group date -> package
		# -> pricing.get_booking_details). company currency/symbol via kaedah
		# jinja ({{ get_company_symbol() }}) di template.
		context.group_dates_json = json.dumps(context.group_dates)
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

		# Video YouTube: extract ID dari URL untuk embed.
		# Sokong format: youtube.com/watch?v=ID, youtu.be/ID, youtube.com/embed/ID
		video_url = (self.video_url or "").strip()
		video_id = ""
		if video_url:
			import re
			m = re.search(r"(?:youtube\.com/watch\?v=|youtu\.be/|youtube\.com/embed/)([A-Za-z0-9_-]{11})", video_url)
			if m:
				video_id = m.group(1)
		context.video_id = video_id
		context.video_url = video_url

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
		# FIXED: guna getattr — field trip_categories mungkin tiada dalam schema lama
		trip_cat = getattr(self, 'trip_categories', None)
		if trip_cat:
			styles.append({"name": trip_cat})
		context.travel_styles = styles

		# Related tours — sama trip_categories, isi dgn trip lain jika kurang.
		context.related = self._related_tours(limit=3)

		context.no_cache = 1
		context.active_nav = "trips"

	def _related_tours(self, limit=3):
		"""Return list of related trip dicts with complete card data."""
		# FIXED: guna getattr — field trip_categories mungkin tiada dalam schema lama
		cat = getattr(self, 'trip_categories', None)
		rows: list = []

		# 1. Main query - same category
		if cat:
			rows = frappe.db.sql(
				"""
				SELECT t.name, t.trip_name, t.route, t.trip_image, t.is_a_cruise_trip,
				       t.trip_categories
				FROM `tabTrip` t
				WHERE t.name != %(me)s AND t.status='Active' AND t.published=1
				  AND t.trip_categories = %(cat)s
				ORDER BY t.trip_name
				LIMIT {lim}
				""".format(lim=int(limit)),
				{"me": self.name, "cat": cat},
				as_dict=True,
			)

		# 2. Fill up if less than limit
		if len(rows) < limit:
			excl = [r.name for r in rows] + [self.name]
			rest = limit - len(rows)
			more = frappe.db.sql(
				"""
				SELECT t.name, t.trip_name, t.route, t.trip_image, t.is_a_cruise_trip,
				       t.trip_categories
				FROM `tabTrip` t
				WHERE t.name NOT IN %(ex)s AND t.status='Active' AND t.published=1
				ORDER BY t.trip_name
				LIMIT {lim}
				""".format(lim=int(rest)),
				{"ex": excl},
				as_dict=True,
			)
			rows += more

		# 3. Fetch destinations for each trip (child table: Trip Destination Point Select)
		for r in rows:
			r["destinations"] = frappe.db.sql(
				"""SELECT dp.destination_name
				   FROM `tabTrip Destination Point Select` ds
				   LEFT JOIN `tabTrip Destination Point` dp ON ds.select_destination_point = dp.name
				   WHERE ds.parent=%s
				   ORDER BY ds.idx LIMIT 5""",
				(r.name,), as_dict=True
			) or []

			# 4. Price + Group Date data
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

				# First group_date per trip
				gd_map = {}
				if rows:
					trips_tuple = tuple([r.name for r in rows])
					in_clause = ",".join(["%s"] * len(trips_tuple))
					gd_rows = frappe.db.sql(
						f"""
						SELECT trip, total_days, total_nights, departure_date,
						       sailing_start, max_participants
						FROM `tabTrip Group Date`
						WHERE trip IN ({in_clause})
						  AND status='Active'
						ORDER BY trip, departure_date ASC
						""",
						trips_tuple,
						as_dict=True
					)
				else:
					gd_rows = []
				for gd in gd_rows:
					if gd["trip"] not in gd_map:
						gd_map[gd["trip"]] = gd

				# 5. Assemble final dict
				for r in rows:
					r["trip_image"] = r.trip_image or "/assets/travel_booking/img/defaultaroyo.jpg"
					r["starting_from_price"] = (
						float(price_map[r.name]) if r.name in price_map and price_map[r.name] else None
					)
					gd = gd_map.get(r.name, {})
					r["_first_gd"] = gd

					if gd:
						base = gd.get("sailing_start") or gd.get("departure_date")
						# Convert date to string for JSON output
						base_str = str(base) if base else ""
						r["next_departure"] = base_str
						r["next_departure_label"] = (
							("Sail" if r.get("is_a_cruise_trip") else "Departs") + " " + base_str
						)
					else:
						r["next_departure"] = ""
						r["next_departure_label"] = ""

		return rows

	def autoname(self):
		# Naming siri TRIP.YY.## — Hanya jana nama baharu untuk dokumen baru.
		# Untuk existing document, name sudah stabil (TRIP26XX) — jangan
		# regenerasi atau DB update akan gagal (WHERE clause match 0 rows).
		if self.is_new():
			self.name = make_autoname(self.naming_series)

	def before_save(self):
		self.title = self.trip_name.upper()
		self.route = "trip/" + self.trip_name.lower().replace(" ", "-")

	def validate(self):
		pass
		
