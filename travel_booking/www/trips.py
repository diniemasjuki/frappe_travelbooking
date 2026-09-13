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
_FILTER_KEYS = ("q", "destination", "item_group", "cruise", "date_from", "date_to", "sort", "currency")


def _get_currency_filter():
    """Currency listing untuk page awam — rantaian keutamaan:

    1. ?currency= param (pilihan eksplisit user)
    2. cookie rc_currency (pilihan tersimpan — ditulis oleh
       public/js/geo_currency.js)
    3. default geolocation (negara dari IP pelawat: MY→MYR, SG→SGD,
       lain-lain → currency default axis — dikawal oleh Travel Website
       > Default Currency by Location)

    Dikongsi oleh page .py lain (tour/cruise/tours/cruises + trip
    detail) supaya logik baca/normalize berada di SATU tempat.
    get_catalog_trips() yang meng-verify nilai (fallback currency
    default kalau tidak diisytiharkan dalam axis).
    """
    from travel_booking.utils.geo_currency import resolve_website_currency

    return resolve_website_currency()


def get_context(context):
    # Baca penapis dari query string. Frappe form_dict hantar semuanya
    # sebagai string; get_catalog_trips() buat .strip() + tafsir.
    filters = {}
    for k in _FILTER_KEYS:
        v = frappe.form_dict.get(k)
        if v:
            filters[k] = v

    # Currency listing: resolve penuh (param > cookie tersimpan > geo
    # default) melalui pintu tunggal _get_currency_filter — bukan terus
    # dari form_dict, supaya default geolocation dipakai bila tiada
    # pilihan eksplisit.
    filters["currency"] = _get_currency_filter()

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
    # SEO: meta + Open Graph + JSON-LD WebSite/SearchAction (rujuk
    # utils/seo.py). OG image guna cover trip pertama bila tersedia.
    from travel_booking.utils.seo import apply_seo, build_website_json_ld

    apply_seo(
        context,
        title="Trips — Rarecation",
        description=(
            "Explore all cruise & tour packages — curated trips with "
            "guaranteed departure dates, transparent pricing and easy "
            "online booking."
        ),
        image=(context.trips[0].trip_image if context.trips else ""),
        json_ld=build_website_json_ld(search_path="/trips"),
    )
    # Meta currency listing (selector + simbol harga card).
    context.currency = data["currency"]
    context.currency_symbol = data["currency_symbol"]
    context.currency_options = data["currency_options"]
    # Company currency/symbol tersedia sebagai kaedah Jinja (rujuk hooks.py
    # jinja.methods); guna {{ get_company_symbol() }} terus di template.
