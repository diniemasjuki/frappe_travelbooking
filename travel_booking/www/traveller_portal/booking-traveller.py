# travel_booking/www/traveller_portal/booking-traveller.py
# /traveller_portal/booking-traveller?ref=<booking_number> — slots + wizard + form.

import frappe

from travel_booking.www.traveller_portal._guard import guard_context

no_cache = 1


def get_context(context):
    ctx = guard_context()
    context.update(ctx)
    context.active_nav = "bookings"
    context.sub_active = "traveller"
    context.booking_ref = (frappe.form_dict.get("ref") or "").strip()
