# travel_booking/www/traveller_portal/_guard.py
#
# Shared SERVER-SIDE auth guard untuk semua page /traveller_portal/*.
# (Nama fail bermula '_' — Frappe tidak expose .py tanpa .html sepadan
# sebagai page, jadi fail ni selamat sebagai module dalaman.)
#
# Kenapa server-side: SPA lama buat semua auth check di client
# (check_session fetch) — page HTML penuh terdedah kepada Guest dan
# hanya disembunyikan oleh JS. Guard ni redirect di peringkat server
# SEBELUM page render: Guest → login page; logged-in tanpa rekod
# Customer → flag account_issue (page papar skrin hubungi sokongan,
# bukan login box yang mengelirukan).

import frappe
import frappe.sessions

from travel_booking.api._helpers import get_customer_by_email


def guard_context(require_customer=True):
	"""Sediakan context asas + enforce auth untuk page portal.

	Pulangkan dict: csrf_token, email, customer_name (docname),
	customer_label (nama paparan), account_issue (bool).

	Behaviour:
	  - Guest                        → redirect ke /traveller_portal (login).
	  - Logged-in + Customer wujud   → context penuh, page render biasa.
	  - Logged-in TANPA Customer     → account_issue=True (page render
	    skrin "Account requires review" — sama macam S-account-issue lama).
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
		ctx["account_issue"] = True
		return ctx

	ctx["account_issue"] = False
	if customer:
		ctx["customer_name"] = customer
		ctx["customer_label"] = (
			frappe.db.get_value("Customer", customer, "customer_name") or customer
		)
	return ctx
