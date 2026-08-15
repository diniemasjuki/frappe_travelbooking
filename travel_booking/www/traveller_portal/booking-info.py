# travel_booking/www/traveller_portal/booking-info.py
# /traveller_portal/booking-info?ref=<booking_number> — ringkasan booking.

import frappe

from travel_booking.www.traveller_portal._guard import guard_context

no_cache = 1


def get_context(context):
    ctx = guard_context()
    context.update(ctx)
    context.active_nav = "bookings"
    context.sub_active = "info"
    context.booking_ref = (frappe.form_dict.get("ref") or "").strip()
