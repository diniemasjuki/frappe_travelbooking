# travel_booking/www/trips.py
#
# Page katalog awam /trips — browsing produk travel dari doctype Trip.
# Penapis SISI-PELAYAN via query string (GET form): mesra SEO, deep-link
# boleh berkongsi (cth. /trips?cruise=1&destination=Yanbu&sort=date).
#
# Data dari lapisan kongsi travel_booking.utils.trip_catalog — SAMA sumber
# dengan wizard booking (/booking). "Ready trip" = Active + ada group date
# Active akan datang + ada package Active. Harga company currency.
import frappe

from travel_booking.utils.trip_catalog import get_catalog_trips, get_filter_options

# nama medan penapis yang diterima dari query string
_FILTER_KEYS = ("q", "destination", "item_group", "cruise", "date_from", "date_to", "sort")


def get_context(context):
    # Baca penapis dari query string. Frappe form_dict hantar semuanya
    # sebagai string; get_catalog_trips() buat .strip() + tafsir.
    filters = {}
    for k in _FILTER_KEYS:
        v = frappe.form_dict.get(k)
        if v:
            filters[k] = v

    data = get_catalog_trips(filters)
    options = get_filter_options()

    context.trips = data["trips"]
    # dict {trip_name: [group_date, ...]} — partial card ambil group date
    # pertama utk duration + seats_left + next departure.
    context.trip_group_dates = data["trip_group_dates"]
    context.trip_packages = data["trip_packages"]
    context.options = options
    # Nilai penapis semasa utk pra-isi bar penapis (highlight pilihan).
    context.active = filters
    context.active_nav = "trips"
    context.no_cache = 1
    context.title = "Trips — Rarecation"
    # Company currency/symbol tersedia sebagai kaedah Jinja (rujuk hooks.py
    # jinja.methods); guna {{ get_company_symbol() }} terus di template.
