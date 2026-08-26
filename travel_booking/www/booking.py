# travel_booking/www/booking.py
import frappe
import frappe.sessions
import json

from travel_booking.api._helpers import get_company_currency
from travel_booking.utils.trip_catalog import get_ready_bundle


def get_context(context):
    # NOTA: nama parameter URL (?trip_master=&trip_group_date=) dikekalkan
    # buat masa ini supaya pautan/bookmark sedia ada tak pecah — walaupun
    # field sebenar doctype dipanggil 'trip' (bukan 'trip_master').
    trip_master     = frappe.form_dict.get("trip_master")
    trip_group_date = frappe.form_dict.get("trip_group_date")

    # Data "ready trip" dipanggil dari lapisan KONGSI trip_catalog — SAMA
    # sumber data dengan katalog awam /trips. "Ready" = Trip Active DAN
    # ada sekurang-kurangnya SATU Trip Group Date Active, tarikh akan
    # datang, DAN ada Trip Package Active. seats_left berasaskan
    # SUM(booked_pax) merentasi booking tak-cancelled (sepadan dengan gate
    # overbooking di confirm_booking). Cruise disusun ikut SAILING date.
    # Trip yang belum lengkap disetup SENGAJA tak dipapar — elak dead-end
    # di step seterusnya. Butiran & justifikasi rujuk utils/trip_catalog.py.
    trips, trip_group_dates, trip_packages, trip_is_cruise = get_ready_bundle()

    context.trips            = trips
    context.trip_group_dates = json.dumps(trip_group_dates)
    context.trip_packages    = json.dumps(trip_packages)
    context.trip_cruise_flags = json.dumps(trip_is_cruise)
    context.trip_master      = trip_master or ""
    context.trip_group_date  = trip_group_date or ""
    context.no_cache         = 1
    context.title            = "Book Your Cruise — Rarecation"

    # Company currency — SEMUA harga pakej disimpan & dicaj dalam company
    # currency; currency lain cuma paparan (converter frontend). Wizard
    # perlukan symbol + code company currency untuk fmt() default + paparan
    # dwi-currency bila customer pilih display currency berbeza.
    company_currency = get_company_currency()
    context.company_currency = company_currency
    context.company_symbol = (
        frappe.db.get_value("Currency", company_currency, "symbol") or company_currency
    )

    context.csrf_token = (
        frappe.sessions.get_csrf_token() if frappe.session.user != "Guest" else ""
    )

    # User info untuk detect post-OAuth login (Google Sign-In auto-verify)
    # Hanya diisi bila session authenticated — JS guna ni utk skip OTP
    if frappe.session.user and frappe.session.user != "Guest":
        context.user = {
            "email":     frappe.session.user,
            "full_name": frappe.db.get_value("User", frappe.session.user, "full_name") or "",
            "first_name": frappe.db.get_value("User", frappe.session.user, "first_name") or "",
            "last_name":  frappe.db.get_value("User", frappe.session.user, "last_name") or "",
        }
    else:
        context.user = None
