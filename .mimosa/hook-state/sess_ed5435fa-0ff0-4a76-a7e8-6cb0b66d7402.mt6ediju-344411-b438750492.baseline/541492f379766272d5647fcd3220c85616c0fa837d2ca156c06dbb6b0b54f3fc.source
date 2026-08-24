# travel_booking/www/traveller/index.py
# Login page controller — serves /traveller

import frappe


def get_context(context):
    """Prepare context for login page.

    - If user is logged in: redirect to bookings (already authenticated).
    - If guest or no customer link: show login form (or account issue view).
    """
    context.no_cache = 1
    context.site_name = frappe.get_cached_value(
        "Travel Settings", None, "site_name"
    ) or "Rarecation"

    # Check if session expired flag was set by JS
    try:
        import json
        from travel_booking.www.traveller._guard import get_query_param
        # We'll pass session_expired as a template var from JS redirect detection
    except Exception:
        pass

    context.session_expired = False
    context.account_issue = False
    context.page_data = {"csrf_token": ""}

    # Check if already logged in → redirect to bookings
    user = frappe.session.user
    if user and user != "Guest":
        # Customer role = portal access. No role = "under review".
        try:
            if "Customer" in frappe.get_roles(user):
                frappe.local.flags.redirect_location = "/traveller/bookings"
                raise frappe.Redirect
            else:
                # Logged in but no Traveller role → under review
                context.account_issue = True
                context.page_data = {
                    "csrf_token": frappe.sessions.get_csrf_token()
                    if frappe.session.user != "Guest" else ""
                }
        except frappe.Redirect:
            raise
        except Exception:
            # If check fails, just show normal login
            pass
    else:
        # Guest user — provide empty CSRF (login doesn't need it until POST)
        context.page_data = {"csrf_token": ""}
