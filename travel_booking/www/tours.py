# travel_booking/www/tours.py
#
# Page katalog tour-sahaja /tours — browsing produk travel BUKAN cruise
# (is_a_cruise_trip = 0) dari doctype Trip. Pencerminan /trips tetapi
# penapis cruise dipaksa kepada "0" sahaja.
#
# Data dari lapisan kongsi travel_booking.utils.trip_catalog — SAMA sumber
# dengan /trips dan /tour. Harga company currency.

import frappe

from travel_booking.utils.trip_catalog import get_catalog_trips, get_filter_options

# nama medan penapis yang diterima dari query string (cruise dipaksa = 0)
_FILTER_KEYS = ("q", "destination", "item_group", "date_from", "date_to", "sort")


def get_context(context):
    # Paksa cruise = 0 (halaman ni khas tour sahaja). Penapis lain dari
    # query string dibaca supaya deep-link boleh berkongsi.
    filters = {"cruise": "0"}
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
    context.active_nav = "tour"  # tunjuk menu tour + highlight
    context.no_cache = 1
    context.title = "Tours — Rarecation"
