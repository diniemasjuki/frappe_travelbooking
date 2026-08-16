# travel_booking/www/traveller_portal/booking_traveller/docs.py
#
# Page: /traveller_portal/booking_traveller/docs?ref={booking_number}&slot={slot_name}
# Aliran dokumen traveller: Langkah 1 upload passport (semakan return
# customer via OCR/MRZ + padanan rekod) → borang maklumat penuh.

import frappe

from travel_booking.www.traveller_portal._guard import get_query_param, guard_context


def get_context(context):
    context.update(guard_context())
    context.booking_ref = get_query_param("ref")
    context.slot_name = get_query_param("slot")
