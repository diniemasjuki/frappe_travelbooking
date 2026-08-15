# travel_booking/www/traveller_portal/booking-traveller.py
# /traveller_portal/booking-traveller?ref=<booking_number> — slots + wizard + form.

from travel_booking.www.traveller_portal._guard import get_query_param, guard_context

no_cache = 1


def get_context(context):
    ctx = guard_context()
    context.update(ctx)
    context.active_nav = "bookings"
    context.sub_active = "traveller"
    context.booking_ref = get_query_param("ref")
