# travel_booking/www/traveller/_guard.py
#
# Shared SERVER-SIDE auth guard untuk semua page /traveller/*.
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
    """Sediakan context asas + enforce auth untuk page traveller portal.

    Pulangkan dict: csrf_token, email, customer_name (docname),
    customer_label (nama paparan).

    Behaviour:
      - Guest                          → redirect ke /traveller (login).
      - Logged-in TANPA role Traveller → redirect ke /traveller juga —
        index.py papar skrin "Account Under Review" (signup tanpa booking;
        role hanya diberi selepas booking pertama).
      - Logged-in + role Traveller     → context penuh, page render biasa.
        Customer mungkin tiada (edge case: staff/testing) — page handle
        empty state sendiri.
    """
    ctx = {
        "no_cache": 1,
        "csrf_token": (
            frappe.sessions.get_csrf_token() if frappe.session.user != "Guest" else ""
        ),
    }

    user = frappe.session.user
    if not user or user == "Guest":
        frappe.local.flags.redirect_location = "/traveller"
        raise frappe.Redirect

    ctx["email"] = user

    # Gatekeeper: hanya role "Customer" dibenarkan akses portal.
    # Tiada role = "under review" (signup tanpa booking) → redirect ke
    # login page, di mana index.py papar skrin "Account Under Review".
    if "Customer" not in frappe.get_roles(user):
        frappe.local.flags.redirect_location = "/traveller"
        raise frappe.Redirect

    customer = get_customer_by_email(user)
    ctx["account_issue"] = False
    if customer:
        ctx["customer_name"] = customer
        ctx["customer_label"] = (
            frappe.db.get_value("Customer", customer, "customer_name") or customer
        )
    return ctx
