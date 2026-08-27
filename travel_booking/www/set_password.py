# travel_booking/www/set_password.py
#
# NAMA FAIL MESTI guna underscore (set_password.py), BUKAN hyphen
# (set-password.py). Frappe's www renderer replace hyphen → underscore bila
# cari Python module bersama HTML template — jadi fail "set-password.py"
# tidak pernah dimuatkan dan get_context tidak pernah dipanggil. HTML
# template kekal "set-password.html" (hyphen).
# Set Password page controller

no_cache = 1
allow_guest = True


def get_context(context):
    context.no_cache = 1
    # Token dibaca oleh JS dari URL query string
    # Tiada server-side check di sini — semua handled by set-password.js
