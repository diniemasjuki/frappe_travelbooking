# travel_booking/www/traveller_portal/booking_traveller/index.py
#
# Page: /traveller_portal/booking_traveller?ref={booking_number}
# Senarai slot traveller (Booking Reservation) bagi satu booking.
# Aliran upload/passport & form traveller pula di /booking_traveller/docs.

import frappe

from travel_booking.www.traveller_portal._guard import get_query_param, guard_context


def get_context(context):
    context.update(guard_context())
    context.booking_ref = get_query_param("ref")
