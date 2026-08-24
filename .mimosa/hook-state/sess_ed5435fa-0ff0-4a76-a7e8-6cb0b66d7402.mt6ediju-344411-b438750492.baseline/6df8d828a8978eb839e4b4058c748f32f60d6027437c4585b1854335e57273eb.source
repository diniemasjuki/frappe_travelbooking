# travel_booking/www/cruises.py
#
# Page katalog cruise-sahaja /cruises — browsing produk travel cruise
# (is_a_cruise_trip = 1) dari doctype Trip. Pencerminan /trips tetapi
# penapis cruise dipaksa kepada "1" sahaja.
#
# Data dari lapisan kongsi travel_booking.utils.trip_catalog — SAMA sumber
# dengan /trips dan /cruise. Harga company currency.

import frappe

from travel_booking.utils.trip_catalog import get_catalog_trips, get_filter_options

# nama medan penapis yang diterima dari query string (cruise dipaksa = 1)
_FILTER_KEYS = ("q", "destination", "item_group", "date_from", "date_to", "sort")


def get_context(context):
    # Paksa cruise = 1 (halaman ni khas cruise sahaja). Penapis lain dari
    # query string dibaca supaya deep-link boleh berkongsi.
    filters = {"cruise": "1"}
    for k in _FILTER_KEYS:
        v = frappe.form_dict.get(k)
        if v:
            filters[k] = v

    data = get_catalog_trips(filters)
    options = get_filter_options()

    context.trips = data["trips"]
    context.trip_group_dates = data["trip_group_dates"]
    context.trip_packages = data["trip_packages"]
    context.options = options
    context.active = filters
    context.active_nav = "cruise"  # tunjuk menu cruise + highlight
    context.no_cache = 1
    context.title = "Cruises — Rarecation"
