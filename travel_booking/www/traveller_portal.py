# travel_booking/www/traveller_portal.py
import frappe
import frappe.sessions

no_cache = 1
allow_guest = True

def get_context(context):
    context.no_cache = 1

    # PENTING: portal ni SENTIASA reachable oleh session authenticated
    # (customer login via magic link, atau link terus dari emel macam
    # "Complete Payment" yang assume session sedia ada dari tab/kunjungan
    # lain — cookie session dikongsi across SEMUA tab dalam browser yang
    # sama). Bila authenticated, Frappe WAJIBKAN token CSRF yang SAH untuk
    # setiap POST (check_session, get_google_login_url, dsb — rujuk
    # portal.js) — tanpa token ni di-embed di sini, portal.js tiada cara
    # boleh dipercayai dapatkan token yang betul (cookie 'csrftoken'
    # browser TAK reliable disegerakkan lepas login_manager.login_as()
    # dalam magic-link flow kita) -> semua POST gagal "invalid request"
    # walaupun customer sah login, portal salah anggap "belum login" dan
    # papar skrin login berulang.
    #
    # Kosongkan terus untuk Guest (customer belum login langsung) — tak
    # perlu/tak digunakan, cookie kosong dah cukup selamat untuk endpoint
    # allow_guest.
    context.csrf_token = (
        frappe.sessions.get_csrf_token() if frappe.session.user != "Guest" else ""
    )