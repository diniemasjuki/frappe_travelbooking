# travel_booking/www/traveller_portal/booking-billing.py
# /traveller_portal/booking-billing?ref=<booking_number> — SO, transaksi, download, bayar.

from travel_booking.www.traveller_portal._guard import get_query_param, guard_context

no_cache = 1


def get_context(context):
    ctx = guard_context()
    context.update(ctx)
    context.active_nav = "bookings"
    context.sub_active = "billing"
    context.booking_ref = get_query_param("ref")
