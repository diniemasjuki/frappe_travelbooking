# Copyright (c) 2026, WargaPrihatin and contributors
# For license information, please see license.txt

import frappe
from travel_booking.utils.website_config import web_date
from frappe.model.document import Document
from frappe.model.naming import make_autoname


class Trip(Document):
	# begin: auto-generated types
	# This code is auto-generated. Do not modify anything in this block.

	from typing import TYPE_CHECKING

	if TYPE_CHECKING:
		from frappe.types import DF
		from travel_booking.travel_booking_management.doctype.trip_facility.trip_facility import TripFacility
		from travel_booking.travel_booking_management.doctype.trip_faq.trip_faq import TripFAQ
		from travel_booking.travel_booking_management.doctype.trip_feature.trip_feature import TripFeature
		from travel_booking.travel_booking_management.doctype.trip_highlight.trip_highlight import TripHighlight
		from travel_booking.travel_booking_management.doctype.trip_itinerary.trip_itinerary import TripItinerary

		description: DF.TextEditor | None
		facilities: DF.Table[TripFacility]
		faqs: DF.Table[TripFAQ]
		featured_trip: DF.Check
		features: DF.Table[TripFeature]
		highlights: DF.Table[TripHighlight]
		is_a_cruise_trip: DF.Check
		itinerary: DF.Table[TripItinerary]
		itinerary_caption: DF.SmallText | None
		itinerary_title: DF.Data | None
		meta_description: DF.SmallText | None
		meta_image: DF.AttachImage | None
		meta_noindex: DF.Check
		meta_title: DF.Data | None
		naming_series: DF.Literal["TRIP.YY.##"]
		published: DF.Check
		route: DF.Data | None
		status: DF.Literal["Pending Review", "Active", "Completed", "Cancelled"]
		title: DF.Data | None
		trip_image: DF.AttachImage | None
		trip_name: DF.Data
		trip_organizer: DF.Link
		video_url: DF.SmallText | None
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
		from travel_booking.www.trips import _get_currency_filter

		# Currency pilihan customer (?currency=SGD) — menapis pakej & harga
		# ikut currency itu; fallback native kalau trip tiada pakej dalam
		# currency tersebut (currency_native_only).
		currency = _get_currency_filter()
		d = get_trip_detail(self.name, currency=currency)
		group_dates_raw = d["group_dates"]
		is_cruise = d["is_cruise"]

		context.group_dates = group_dates_raw
		context.group_date_groups = d.get("group_date_groups") or []
		context.trip_packages = d["trip_packages"]
		# Peta sailing_start → SEMUA TGD (pré-dedupe) — untuk union pakej ikut
		# sailing di trip_detail.js + resolusi TGD (pakej + sailing) semasa
		# Book Now (termasuk popup bila ada >1 departure date).
		context.sailing_tgds = d.get("sailing_tgds") or {}
		context.starting_from_price = d["starting_from_price"]
		context.destinations = d["destinations"]
		context.is_cruise = d["is_cruise"]
		# Meta currency page detail — currency aktif + fallback flag +
		# pilihan selector (axis). currency_symbol = simbol currency LISTING
		# aktif (trip_card dsb.); starting_from_* = currency/simbol SEBENAR
		# harga "from" (native pakej termurah bila currency_native_only).
		context.currency = d.get("currency")
		context.currency_symbol = d.get("currency_symbol")
		context.currency_native_only = d.get("currency_native_only")
		context.starting_from_currency = d.get("starting_from_currency")
		context.starting_from_symbol = d.get("starting_from_symbol")
		from travel_booking.api.currency_axis import get_currency_options
		context.currency_options = get_currency_options()
		# Breadcrumb "Trips" dinamik mengikut jenis produk ini: cruise →
		# Cruises (/cruises); tour → Tours (/tours).
		context.trips_crumb = (
			{"label": "Cruises", "url": "/cruises"} if is_cruise
			else {"label": "Tours", "url": "/tours"}
		)
		# JSON untuk widget keberangkatan di JS (select group date -> package
		# -> pricing.get_booking_details). company currency/symbol via kaedah
		# jinja ({{ get_company_symbol() }}) di template.
		context.group_dates_json = json.dumps(context.group_dates)
		context.trip_packages_json = json.dumps(d["trip_packages"])
		context.sailing_tgds_json = json.dumps(context.sailing_tgds)
		context.trip_image = self.trip_image or "/assets/travel_booking/img/defaultaroya.jpg"
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
		itin_rows = [
			{
				"day": r.day,
				"day_title": r.day_title or "",
				"destination_point": r.destination_point or "",
				"destination_name": (dp_map.get(r.destination_point, {}) or {}).get("destination_name") or r.destination_point or "",
				"country": (dp_map.get(r.destination_point, {}) or {}).get("destination_country") or "",
				"meals": r.meals or "",
				"day_image": r.day_image or "",
				"description": r.description or "",
				# Segment kosong (trip lama) / nilai asing dianggap Cruise.
				"segment": (r.get("segment") or "").strip() or "Cruise",
			}
			for r in sorted(self.itinerary or [], key=lambda x: x.day or 0)
		]
		context.itinerary = itin_rows

		# Segmented itinerary (cruise sahaja): hari penerbangan awal/lewat
		# dipaparkan sebagai fasa Pre-Cruise → Cruise → Post-Cruise. Bukan
		# cruise, atau semua hari dalam satu segment → template render flat
		# seperti biasa (tiada header segment).
		context.itinerary_segments = []
		if self.is_a_cruise_trip:
			segment_meta = {
				"Pre-Cruise": {"label": "Pre-Cruise + Flight (Departure)", "icon": "ti-plane-departure"},
				"Cruise": {"label": "Cruise · Onboard", "icon": "ti-ship"},
				"Post-Cruise": {"label": "Post-Cruise + Flight (Return)", "icon": "ti-plane-arrival"},
			}
			grouped: dict = {}
			for row in itin_rows:
				seg = row["segment"] if row["segment"] in segment_meta else "Cruise"
				grouped.setdefault(seg, []).append(row)
			context.itinerary_segments = [
				{
					"key": seg,
					"label": segment_meta[seg]["label"],
					"icon": segment_meta[seg]["icon"],
					"rows": grouped[seg],
					"day_from": grouped[seg][0]["day"],
					"day_to": grouped[seg][-1]["day"],
				}
				for seg in ("Pre-Cruise", "Cruise", "Post-Cruise")
				if seg in grouped
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
		# Harga kad ditapis ikut currency listing aktif (pola sama catalog);
		# trip tanpa pakej dalam currency itu → "On Request".
		context.related = self._related_tours(limit=3, currency=currency)

		# ── SEO (meta description, canonical, Open Graph, JSON-LD) ──
		# Meta description: keutamaan meta_description > description
		# (dibersihkan HTML oleh helper). OG image: meta_image > cover.
		# JSON-LD: Product+Offer (harga dari mulai), FAQPage bila ada FAQ,
		# BreadcrumbList Home > Cruises/Tours > trip ini.
		from travel_booking.utils.seo import apply_seo, build_trip_json_ld
		dest_names = [
			d.get("destination_name")
			for d in (context.destinations or [])
			if (d.get("destination_name") or "").strip()
		]
		apply_seo(
			context,
			title=self.meta_title or (self.trip_name or self.name),
			description=self.meta_description or self.description or "",
			image=context.trip_image,
			page_type="product",
			noindex=bool(self.meta_noindex),
			json_ld=build_trip_json_ld(
				trip_name=self.trip_name or self.name,
				description=self.meta_description or self.description or "",
				image=context.trip_image,
				page_url_path=(
					frappe.local.request.path
					if getattr(frappe.local, "request", None)
					else f"/{self.route or self.name.lower()}"
				),
				is_cruise=bool(self.is_a_cruise_trip),
				price=context.starting_from_price,
				# Currency SEBENAR harga "from" (currency listing secara
				# normal; currency native pakej bila currency_native_only).
				currency=(
					context.starting_from_currency
					or context.currency
					or frappe.db.get_single_value("Global Defaults", "default_currency")
				),
				organizer=context.organizer_name or "",
				faqs=context.faqs,
				destinations=dest_names,
				breadcrumb=[
					{"label": "Home", "url": "/"},
					context.trips_crumb,
					{"label": self.trip_name or self.name},
				],
			),
		)

		context.no_cache = 1
		context.active_nav = "trips"

	def _related_tours(self, limit=3, currency=None):
		"""Return list of related trip dicts with complete card data."""
		# FIXED: guna getattr — field trip_categories mungkin tiada dalam schema lama
		cat = getattr(self, 'trip_categories', None)
		# Saring ikut jenis trip — cruise cuma cadang cruise, tour cuma cadang tour.
		cruise = 1 if self.is_a_cruise_trip else 0
		rows: list = []

		# 1. Main query - same category + same cruise type
		if cat:
			rows = frappe.db.sql(
				"""
				SELECT t.name, t.trip_name, t.route, t.trip_image, t.is_a_cruise_trip,
				       t.trip_categories
				FROM `tabTrip` t
				WHERE t.name != %(me)s AND t.status='Active' AND t.published=1
				  AND t.trip_categories = %(cat)s
				  AND t.is_a_cruise_trip = %(cruise)s
				ORDER BY t.trip_name
				LIMIT {lim}
				""".format(lim=int(limit)),
				{"me": self.name, "cat": cat, "cruise": cruise},
				as_dict=True,
			)

		# 2. Fill up if less than limit (same cruise type only)
		if len(rows) < limit:
			excl = [r.name for r in rows] + [self.name]
			rest = limit - len(rows)
			more = frappe.db.sql(
				"""
				SELECT t.name, t.trip_name, t.route, t.trip_image, t.is_a_cruise_trip,
				       t.trip_categories
				FROM `tabTrip` t
				WHERE t.name NOT IN %(ex)s AND t.status='Active' AND t.published=1
				  AND t.is_a_cruise_trip = %(cruise)s
				ORDER BY t.trip_name
				LIMIT {lim}
				""".format(lim=int(rest)),
				{"ex": excl, "cruise": cruise},
				as_dict=True,
			)
			rows += more

			# 3. Fetch destinations for each trip — ambil terus dari destination
			# yang tersenarai dalam itinerary (Trip Itinerary.destination_point),
			# dedup ikut kemunculan hari terawal (sumber sama dengan section
			# Destination pada page detail).
			for r in rows:
				r["destinations"] = frappe.db.sql(
					"""SELECT dp.destination_name
					   FROM `tabTrip Itinerary` it
					   JOIN `tabTrip Destination Point` dp ON dp.name = it.destination_point
					   WHERE it.parent=%s AND it.parenttype='Trip'
					     AND it.destination_point IS NOT NULL AND it.destination_point != ''
					   GROUP BY dp.name, dp.destination_name
					   ORDER BY MIN(it.day) LIMIT 5""",
					(r.name,), as_dict=True
				) or []

			# 4. Price + Group Date data. Harga "from" ditapis ikut currency
			# listing aktif (pola sama _add_starting_price di trip_catalog —
			# tanpa tapisan ini MIN bercampur-campur currency). Trip tanpa
			# pakej dalam currency itu → starting_from_price None → kad
			# papar "On Request".
			if rows:
				price_cond = "AND tp.currency = %(cur)s" if currency else ""
				price_map = {
					r["trip"]: r["mn"]
					for r in frappe.db.sql(
						"""
						SELECT tp.trip_link AS trip, MIN(pr.price_adult) AS mn
						FROM `tabTrip Package` tp
						JOIN `tabTrip Package Price` pr ON pr.parent = tp.name
						WHERE tp.trip_link IN %(names)s AND tp.status='Active' {price_cond}
						GROUP BY tp.trip_link
						""".format(price_cond=price_cond),
						{"names": [r.name for r in rows], "cur": currency},
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
						       sailing_start, max_participants, is_cruise_only
						FROM `tabTrip Group Date`
						WHERE trip IN ({in_clause})
						  AND status='Active'
						ORDER BY trip, COALESCE(sailing_start, departure_date) ASC,
						         is_cruise_only DESC, departure_date ASC
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
					r["trip_image"] = r.trip_image or "/assets/travel_booking/img/defaultaroya.jpg"
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
						# Label tarikh diformat ikut konfigurasi Travel Website
						# (web_date) — konsisten dengan kad katalog.
						r["next_departure_label"] = (
							("Sail" if r.get("is_a_cruise_trip") else "Departs") + " " + web_date(base)
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
		# jangan usik 
		self.title = self.trip_name.upper()
		self.route = self.name.lower()
		# self.route = self.name.lower().replace(" ", "-").replace("//", "/").replace("--", "-")
		# self.route = self.route.lower().replace("--", "-").replace("---", "-")
		# jangan usik - end

	def validate(self):
		pass

	def on_update(self):
		"""Propagate trip_name & package_title ke semua linked doctypes apabila berubah."""
		if self.has_value_changed("trip_name"):
			self._propagate_trip_name()
			self._propagate_package_title()

	def _propagate_trip_name(self):
		"""Push trip_name terkini ke semua rekod yang link ke Trip ini.

		Linked doctypes:
		- Trip Package       (link: trip_link)
		- Trip Group Date    (link: trip)
		- Trip Cruise Schedule (link: trip_link)
		"""
		new_name = self.trip_name
		linked = [
			("Trip Package", "trip_link"),
			("Trip Group Date", "trip"),
			("Trip Cruise Schedule", "trip_link"),
		]

		for doctype, link_field in linked:
			try:
				frappe.db.sql(
					f"""UPDATE `tab{doctype}`
						SET trip_name = %s
						WHERE `{link_field}` = %s AND (trip_name IS NULL OR trip_name != %s)""",
					(new_name, self.name, new_name),
				)
			except Exception:
				frappe.log_error(
					frappe.get_traceback(),
					f"Trip: Failed to propagate trip_name to {doctype} for {self.name}",
				)

	def _propagate_package_title(self):
		"""Regenerate package_title untuk semua Trip Package yang link ke Trip ini.

		package_title format: "{trip_name} : {package_type} : {airport_or_currency}"
		Dipanggil bila trip_name berubah supaya package_title sentiasa sync.
		"""
		new_trip_name = self.trip_name

		try:
			# Dapatkan semua Trip Package yang link ke Trip ini
			packages = frappe.db.sql(
				"""SELECT name, package_type, airport_form, currency
				   FROM `tabTrip Package`
				   WHERE trip_link = %s""",
				(self.name,),
				as_dict=True,
			)

			for pkg in packages:
				try:
					# Generate package_type code (same logic as Trip Package validate())
					pt = pkg.package_type or ""
					if pt == "Cruise + Flight":
						pt_code = "FC"
					elif pt == "Cruise Only":
						pt_code = "CO"
					elif pt == "Fly Package":
						pt_code = "FP"
					elif pt == "Ground Only":
						pt_code = "GP"
					elif pt == "Customed":
						pt_code = "CU"
					else:
						pt_code = ""

					# Determine airport/currency suffix (same logic as Trip Package)
					if pt_code in ("CO", "GP"):
						airport = pkg.currency or "MYR"
					else:
						airport = pkg.airport_form or ""

					# Regenerate package_title
					new_title = f"{new_trip_name or ''} : {pkg.package_type or ''} : {airport}"

					# Update only if changed
					frappe.db.sql(
						"""UPDATE `tabTrip Package`
						   SET package_title = %s
						   WHERE name = %s AND (package_title IS NULL OR package_title != %s)""",
						(new_title, pkg.name, new_title),
					)
				except Exception:
					frappe.log_error(
						frappe.get_traceback(),
						f"Trip: Failed to update package_title for Trip Package {pkg.name}",
					)

		except Exception:
			frappe.log_error(
				frappe.get_traceback(),
				f"Trip: Failed to propagate package_title for {self.name}",
			)
			
