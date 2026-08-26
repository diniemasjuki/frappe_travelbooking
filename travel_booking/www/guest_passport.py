# travel_booking/www/guest_passport.py
#
# Page: /guest_passport?token={passport_link_token}
# Co-traveller (guest, no login) isi maklumat passport/contact/health mereka
# sendiri via token link yang dijana oleh customer/admin
# (request_guest_passport_link).
#
# TIDAK memanggil guard_context() — page ini sengaja diakses oleh Guest (tiada
# session). Auth dihandle oleh token (verify_guest_token) di peringkat API:
# token invalid/expired → API throw, JS papar mesej ralat. Ini selamat kerana
# tiada data slot/traveller terdedah sehingga token disahkan (verify_guest_token
# throw sebelum pulangkan konteks).

import frappe

# FIXED: Import dari path yang betul (traveller, bukan traveller_portal)
from travel_booking.www.traveller._guard import get_query_param


def get_context(context):
    context.no_cache = 1
    # csrf token diperlukan untuk POST ke endpoint allow_guest (get_guest_file,
    # save_booking_traveller, confirm_traveller_documents). Frappe menetapkan
    # cookie csrftoken untuk Guest juga; get_csrf_token() pulangkan & menjananya.
    context.csrf_token = frappe.sessions.get_csrf_token()
    context.token = get_query_param("token")
