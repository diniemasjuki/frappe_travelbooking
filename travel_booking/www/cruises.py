# travel_booking/www/cruises.py
#
# Page katalog cruise-sahaja /cruises — browsing produk travel cruise
# (is_a_cruise_trip = 1) dari doctype Trip. Pencerminan /trips tetapi
# penapis cruise dipaksa kepada "1" sahaja.
#
# Bar penapis cruise: carian + destinasi + BULAN & TAHUN pelayaran sahaja
# (item_group, from/to date & sort_by dibuang — katalog cruise tak guna).
# month/year ditafsir bebas oleh get_catalog_trips (bulan itu pada
# mana-mana tahun bila tahun = semua).
#
# Data dari lapisan kongsi travel_booking.utils.trip_catalog — SAMA sumber
# dengan /trips dan /cruise. Harga company currency.

import calendar

import frappe

from travel_booking.utils.trip_catalog import get_catalog_trips, get_filter_options

# nama medan penapis yang diterima dari query string (cruise dipaksa = 1;
# month/year adalah pasangan bulan-tahun pelayaran, bukan julat tarikh)
_FILTER_KEYS = ("q", "destination", "month", "year", "currency")


def _sailing_periods() -> tuple[list, list]:
	"""Tahun & bulan sebenar yang ada pelayaran cruise ready (group date
	Active, tarikh akan datang, ada package Active, trip Active cruise) —
	dropdown bulan/tahun hanya papar pilihan yang betul-betul ada sailing,
	tak ada pilihan kosong. Tarikh rujukan = sailing_start dengan fallback
	departure_date, SEPADAN _date_in_range get_catalog_trips."""
	rows = frappe.db.sql(
		"""
		SELECT DISTINCT
			YEAR(COALESCE(td.sailing_start, td.departure_date)) AS y,
			MONTH(COALESCE(td.sailing_start, td.departure_date)) AS m
		FROM `tabTrip Group Date` td
		JOIN `tabTrip` t ON t.name = td.trip
		WHERE td.status = 'Active'
		  AND td.departure_date >= CURDATE()
		  AND t.status = 'Active'
		  AND t.is_a_cruise_trip = 1
		  AND EXISTS (
		      SELECT 1
		      FROM `tabTrip Package Group Date Select` sel
		      JOIN `tabTrip Package` tp ON tp.name = sel.parent
		      WHERE sel.trip_group_date = td.name
		        AND tp.status = 'Active'
		  )
		ORDER BY y, m
		""",
		as_dict=True,
	)
	years: list = []
	months: list = []
	for r in rows:
		if r.y and int(r.y) not in years:
			years.append(int(r.y))
		if r.m and int(r.m) not in months:
			months.append(int(r.m))
	return sorted(years), sorted(months)


def get_context(context):
	# Paksa cruise = 1 (halaman ni khas cruise sahaja). Penapis lain dari
	# query string dibaca supaya deep-link boleh berkongsi.
	filters = {"cruise": "1"}
	for k in _FILTER_KEYS:
		v = frappe.form_dict.get(k)
		if v:
			filters[k] = v

	# Currency listing: resolve penuh (?currency= > cookie tersimpan >
	# default geolocation IP pelawat) melalui pintu tunggal yang dikongsi
	# dengan page katalog/homepage lain.
	from travel_booking.www.trips import _get_currency_filter
	filters["currency"] = _get_currency_filter()

	data = get_catalog_trips(filters)
	options = get_filter_options(cruise=1)

	# Pilihan dropdown bulan/tahun — label bulan Inggeris (UI katalog),
	# nilai = nombor bulan 1–12 / tahun penuh.
	_years, _months = _sailing_periods()
	context.month_options = [
		{"value": m, "label": calendar.month_name[m]} for m in _months
	]
	context.year_options = _years

	context.trips = data["trips"]
	context.trip_group_dates = data["trip_group_dates"]
	context.trip_packages = data["trip_packages"]
	context.options = options
	context.active = filters
	context.active_nav = "cruise"  # tunjuk menu cruise + highlight
	context.no_cache = 1
	context.title = "Cruises — Rarecation"
	# SEO: meta + Open Graph + JSON-LD WebSite/SearchAction (rujuk
	# utils/seo.py). OG image guna cover trip pertama bila tersedia.
	from travel_booking.utils.seo import apply_seo, build_website_json_ld

	apply_seo(
		context,
		title="Cruises — Rarecation",
		description=(
			"Luxury cruise voyages to the world's most breathtaking "
			"destinations — browse sailing dates, cabin packages and "
			"book online."
		),
		image=(context.trips[0].trip_image if context.trips else ""),
		json_ld=build_website_json_ld(search_path="/cruises"),
	)
	# Meta currency listing (selector + simbol harga card)
	context.currency = data["currency"]
	context.currency_symbol = data["currency_symbol"]
	context.currency_options = data["currency_options"]
