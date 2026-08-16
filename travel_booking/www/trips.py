# travel_booking/www/trips.py
#
# List page /trips — halaman "catalogue" pakej travel Rarecation:
#   1. Grid Trip published (setiap card → halaman detail trip)
#   2. Senarai SEMUA tarikh perlepasan akan datang, dikumpulkan per
#      bulan — butang "Book" terus buka wizard /booking?date=<tgd>
#      (deep link ?date= sudah disokong oleh booking.js).
#
# Query datang dari web_data.py (layer yang SAMA dengan halaman detail
# Trip) supaya syarat "ready untuk booking" konsisten.

import frappe

from travel_booking.travel_booking_management.doctype.trip.web_data import (
	fmt_month,
	get_published_trips,
	get_support_contacts,
	get_upcoming_departures,
)

no_cache = 1


def get_context(context):
	trips = get_published_trips()
	departures = get_upcoming_departures()

	# Kelompokkan tarikh per bulan ("September 2026"), kekal urut kronologi.
	# NOTA: guna kunci "departures" (BUKAN "items") — dalam Jinja, akses
	# attribute m.items atas dict akan pulangkan builtin dict.items() dulu
	# sebelum lookup kunci, jadi {% for dep in m.items %} akan TypeError.
	months, by_month = [], {}
	for dep in departures:
		key = dep["month_key"]
		if key not in by_month:
			group = {"key": key, "label": fmt_month(key), "departures": []}
			by_month[key] = group
			months.append(group)
		by_month[key]["departures"].append(dep)

	context.update({
		"trips": trips,
		"months": months,
		"support": get_support_contacts(),
		"current_year": frappe.utils.now_datetime().year,
		"title": "Cruise & Travel Packages — Rarecation",
		"no_cache": 1,
	})
	return context
