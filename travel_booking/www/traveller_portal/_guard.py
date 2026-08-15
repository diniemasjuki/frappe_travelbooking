# travel_booking/www/traveller_portal/_guard.py
#
# Shared SERVER-SIDE auth guard untuk semua page /traveller_portal/*.
# (Nama fail bermula '_' — Frappe tidak expose .py tanpa .html sepadan
# sebagai page, jadi fail ni selamat sebagai module dalaman.)
#
# Kenapa server-side: SPA lama buat semua auth check di client
# (check_session fetch) — page HTML penuh terdedah kepada Guest dan
# hanya disembunyikan oleh JS. Guard ni redirect di peringkat server
# SEBELUM page render.

import frappe
import frappe.sessions

from travel_booking.api._helpers import get_customer_by_email


def get_query_param(name):
    """Baca query parameter (?ref=...) dari KEDUA-DUA sumber:

      1. frappe.form_dict     — pattern Frappe www klasik (GET params
         biasanya dimasukkan ke sini oleh init_request).
      2. frappe.request.args  — Flask query string mentah, SENTIASA
         ada untuk GET request.

    Kenapa dua: kelakuan form_dict untuk GET request pada www page TAK
    konsisten merentas versi Frappe (ada versi hanya populate ia untuk
    POST/JSON body) — punca page booking memaparkan "booking reference
    missing" walaupun ?ref=RC123 jelas ada dalam URL. Fallback
    request.args buat bacaan bulletproof untuk semua versi.
    """
    val = None
    try:
        val = frappe.form_dict.get(name)
    except Exception:
        val = None
    if not val:
        try:
            val = frappe.request.args.get(name)
        except Exception:
            val = None
    return str(val).strip() if val else ""


def guard_context(require_customer=True):
    """Sediakan context asas + enforce auth untuk page portal.

    Pulangkan dict: csrf_token, email, customer_name (docname),
    customer_label (nama paparan).

    Behaviour:
      - Guest                          → redirect ke /traveller_portal (login).
      - Logged-in TANPA Customer       → redirect ke /traveller_portal juga —
        index.py akan papar skrin "Account requires review" (bukan login box
        yang mengelirukan; punca sebenar ialah data, bukan authentication).
        index.py TIDAK memanggil guard_context, jadi tiada redirect loop.
      - Logged-in + Customer wujud     → context penuh, page render biasa.
    """
    ctx = {
        "no_cache": 1,
        "csrf_token": (
            frappe.sessions.get_csrf_token() if frappe.session.user != "Guest" else ""
        ),
    }

    user = frappe.session.user
    if not user or user == "Guest":
        frappe.local.flags.redirect_location = "/traveller_portal"
        raise frappe.Redirect

    ctx["email"] = user
    customer = get_customer_by_email(user)

    if require_customer and not customer:
        frappe.local.flags.redirect_location = "/traveller_portal"
        raise frappe.Redirect

    ctx["account_issue"] = False
    if customer:
        ctx["customer_name"] = customer
        ctx["customer_label"] = (
            frappe.db.get_value("Customer", customer, "customer_name") or customer
        )
    return ctx
