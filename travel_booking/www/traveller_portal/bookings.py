# travel_booking/www/traveller_portal/bookings.py
# /traveller_portal/bookings — My Bookings (default page selepas login).

from travel_booking.www.traveller_portal._guard import guard_context

no_cache = 1


def get_context(context):
    ctx = guard_context()
    context.update(ctx)
    context.active_nav = "bookings"
