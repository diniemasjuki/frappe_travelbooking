# travel_booking/www/traveller_portal/index.py
# /traveller_portal — login page (atau auto-redirect ke My Bookings).

import frappe
import frappe.sessions

from travel_booking.api._helpers import get_customer_by_email

no_cache = 1
allow_guest = True


def get_context(context):
    context.no_cache = 1
    # CSRF token server-side — satu-satunya sumber dipercayai untuk semua
    # POST portal selepas magic-link/Google login (cookie 'csrftoken' tak
    # reliable lepas login_manager.login_as(); rujuk nota portal_common.js).
    context.csrf_token = (
        frappe.sessions.get_csrf_token() if frappe.session.user != "Guest" else ""
    )

    if frappe.session.user != "Guest":
        customer = get_customer_by_email(frappe.session.user)
        if customer:
            # Customer sah login → terus ke My Bookings. Ini kekalkan
            # SEMUA pautan lama (emel status, magic link, Google redirect,
            # emel set-password) yang menuju ke /traveller_portal terus
            # berfungsi tanpa login semula.
            frappe.local.flags.redirect_location = "/traveller_portal/bookings"
            raise frappe.Redirect
        # Logged-in tapi rekod Customer putus — papar skrin isu akaun
        # (bukan login box; customer akan cuba login semula dan tetap gagal
        # sebab punca sebenar ialah data, bukan authentication).
        context.account_issue = True
    else:
        context.account_issue = False

    context.active_nav = ""
