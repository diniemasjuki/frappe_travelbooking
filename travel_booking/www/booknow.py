# travel_booking/www/booknow.py
#
# Page wizard tempahan /booknow — clone flow /booking dengan tema Rarecation.
# Terima parameter URL yang sama (?trip_master= & ?trip_group_date=) supaya
# pautan dari trip detail page terus berfungsi. Sistem flow & rules 100% sama
# dengan /booking; bezanya hanya tema visual (gold/dark/cream).
import frappe
import frappe.sessions
import json

from travel_booking.api._helpers import get_company_currency
from travel_booking.utils.trip_catalog import get_ready_bundle


def get_context(context):
    # Parameter URL — dikekalkan sama seperti /booking untuk compatibility.
    trip_master     = frappe.form_dict.get("trip_master")
    trip_group_date = frappe.form_dict.get("trip_group_date")

    # Data "ready trip" dari lapisan kongsi trip_catalog — identik /booking.
    trips, trip_group_dates, trip_packages, trip_is_cruise = get_ready_bundle()

    context.trips            = trips
    context.trip_group_dates = json.dumps(trip_group_dates)
    context.trip_packages    = json.dumps(trip_packages)
    context.trip_cruise_flags = json.dumps(trip_is_cruise)
    context.trip_master      = trip_master or ""
    context.trip_group_date  = trip_group_date or ""
    context.no_cache         = 1
    context.title            = "Book Now — Rarecation"

    # Company currency — semua harga dalam company currency.
    company_currency = get_company_currency()
    context.company_currency = company_currency
    context.company_symbol = (
        frappe.db.get_value("Currency", company_currency, "symbol") or company_currency
    )

    context.csrf_token = (
        frappe.sessions.get_csrf_token() if frappe.session.user != "Guest" else ""
    )
