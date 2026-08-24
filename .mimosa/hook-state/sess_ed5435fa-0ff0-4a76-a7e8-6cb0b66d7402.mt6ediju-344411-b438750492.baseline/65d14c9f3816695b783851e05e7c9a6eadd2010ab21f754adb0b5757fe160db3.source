# travel_booking/www/traveller_portal/index.py
# /traveller_portal — login page (atau auto-redirect ke My Bookings).

import frappe
import frappe.sessions

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
        if "Customer" in frappe.get_roles(frappe.session.user):
            # Customer role = portal access → terus ke My Bookings.
            frappe.local.flags.redirect_location = "/traveller_portal/bookings"
            raise frappe.Redirect
        # Logged-in tapi tiada role Traveller — akaun "under review"
        # (signup tanpa booking). Papar skrin isu akaun.
        context.account_issue = True
    else:
        context.account_issue = False

    context.active_nav = ""
