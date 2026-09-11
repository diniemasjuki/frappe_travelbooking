# travel_booking/www/traveller/onbehalf.py
# On-Behalf Bookings list page controller — serves /traveller/onbehalf
#
# Khas untuk manager on-behalf (role dikonfigurasi dalam Travel Settings >
# On-Behalf Booking Roles): senarai booking yang mereka buat BAGI PIHAK
# customer lain (booked_by = user, booking_channel != Direct) untuk
# diuruskan — buka detail, billing, isi traveller, dsb.

import frappe
from travel_booking.api._helpers import has_on_behalf_role
from travel_booking.www.traveller._guard import guard_context


def get_context(context):
    """Prepare context for on-behalf bookings list page."""
    ctx = guard_context(require_customer=True)
    context.update(ctx)

    # Page ini khusus untuk manager on-behalf — user tanpa role yang
    # dikonfigurasi (termasuk customer biasa yang tersasar ke URL ni)
    # dihantar balik ke senarai My Bookings. (guard_context dah benarkan
    # mereka masuk portal; ini sekadar routing halaman, bukan sekuriti —
    # endpoint data turut menyaring ikut role.)
    if not has_on_behalf_role(frappe.session.user):
        frappe.local.flags.redirect_location = "/traveller/bookings"
        raise frappe.Redirect

    context.site_name = frappe.get_cached_value(
        "Travel Settings", None, "site_name"
    ) or "Rarecation"
    context.active_nav = 'onbehalf'
    context.booking_ref = None
    context.active_tab = None

    # pageData mesti dict yang boleh JSON-serialize untuk <script> tag
    context.page_data = {
        "csrf_token": ctx.get("csrf_token", ""),
        "booking_ref": ""
    }

    return context
