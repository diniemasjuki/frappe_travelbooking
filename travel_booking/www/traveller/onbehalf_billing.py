# travel_booking/www/traveller/onbehalf_billing.py
# On-behalf BILLING page controller — serves /traveller/onbehalf-billing
# (nama fail garis bawah: Frappe cari controller <route dgn '-' diganti '_'>.py
#  — konvensyen sama dengan onbehalf_booking.py)
#
# Billing (Sales Order + payment) booking yang manager (affiliate / sales
# user) buat BAGI PIHAK customer lain — pasangan kepada /traveller/billing
# (page pemilik). Berasingan supaya pengurusan kebenaran jelas:
#   - Page ini MENUNTUT role on-behalf (Travel Settings > On-Behalf
#     Booking Roles) — user lain dihantar balik ke senarai masing-masing.
#   - Data disaring server-side oleh get_booking_so_payments (milik
#     sendiri ATAU managed booked_by + channel != Direct); page ini
#     sekadar routing, bukan sekuriti.
#   - pageData membawa mode="onbehalf" — traveller_billing.js guna
#     endpoint booking-scoped, papar blok customer akhir & kawal butang
#     ikut TAHAP AKSES (View/Docs/Full) yang dikonfigurasi per-role.

import frappe
from travel_booking.api._helpers import has_on_behalf_role
from travel_booking.www.traveller._guard import guard_context, get_query_param


def get_context(context):
    """Prepare context for on-behalf billing page."""
    ctx = guard_context(require_customer=True)
    context.update(ctx)

    # Khusus manager on-behalf — customer biasa yang tersasar ke URL ni
    # dibawa balik ke My Bookings. (Routing halaman sahaja; endpoint data
    # tetap menolak akses bukan-manager secara independen.)
    if not has_on_behalf_role(frappe.session.user):
        frappe.local.flags.redirect_location = "/traveller/bookings"
        raise frappe.Redirect

    context.site_name = frappe.get_cached_value(
        "Travel Settings", None, "site_name"
    ) or "Rarecation"
    context.active_nav = 'onbehalf'
    context.active_tab = 'billing'

    # Get booking ref from query param
    booking_ref = get_query_param('ref')
    context.booking_ref = booking_ref if booking_ref else None

    # pageData mesti dict yang boleh JSON-serialize
    context.page_data = {
        "csrf_token": ctx.get("csrf_token", ""),
        "booking_ref": context.booking_ref or "",
        "mode": "onbehalf",
    }

    return context
