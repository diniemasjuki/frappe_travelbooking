# travel_booking/www/traveller/onbehalf_booking.py
# On-behalf booking DETAIL page controller — serves /traveller/onbehalf-booking
#
# Detail booking yang manager (affiliate / sales user) buat BAGI PIHAK
# customer lain. Berasingan dari /traveller/booking (halaman pemilik)
# supaya pengurusan kebenaran jelas:
#   - Page ini MENUNTUT role on-behalf (Travel Settings > On-Behalf
#     Booking Roles) — user lain dihantar balik ke senarai masing-masing.
#   - Data masih disaring server-side oleh get_booking_data (set managed
#     booked_by + channel != Direct); page ini sekadar routing, bukan
#     sekuriti.
#   - pageData membawa mode="onbehalf" — traveller_detail.js papar blok
#     customer akhir + kawal butang ikut TAHAP AKSES (View/Docs/Full)
#     yang dikonfigurasi per-role.

import frappe
from travel_booking.www.traveller._guard import guard_context, get_query_param, require_on_behalf_manager


def get_context(context):
    """Prepare context for on-behalf booking detail page."""
    ctx = guard_context(require_customer=True)
    context.update(ctx)

    # Khusus manager on-behalf — customer biasa yang tersasar ke URL ni
    # dibawa balik ke My Bookings. (Routing halaman sahaja; endpoint data
    # tetap menolak akses bukan-manager secara independen.)
    require_on_behalf_manager()

    context.site_name = frappe.get_cached_value(
        "Travel Settings", None, "site_name"
    ) or "Rarecation"
    context.active_nav = 'onbehalf'
    context.active_tab = 'info'

    booking_ref = get_query_param('ref')
    context.booking_ref = booking_ref if booking_ref else None

    # Senarai negara untuk dropdown modal "Edit Billing Info" — dibaca
    # server-side (Guest/user tak boleh list doctype Country melalui API
    # biasa). Nilai = NAMA canonical dokumen Country (Malaysia didahulukan,
    # selebihnya A-Z), selari dengan wizard /booknow.
    _countries = frappe.get_all("Country", pluck="name")
    countries = sorted(_countries, key=lambda n: (n != "Malaysia", n))

    # pageData mesti dict yang boleh JSON-serialize
    context.page_data = {
        "csrf_token": ctx.get("csrf_token", ""),
        "booking_ref": context.booking_ref or "",
        "mode": "onbehalf",
        "billing_countries": countries,
    }

    return context
