"""Seed default mapping geo-currency (Travel Website > Default Currency
by Location): Malaysia -> MYR, Singapore -> SGD.

Idempotent — hanya seed BILA table mapping kosong (pasang baru). Edit
admin kemudian tidak akan ditimpa; untuk "disable" mapping, guna toggle
Enable Currency Default by Geolocation (jangan padam baris satu-satu
kerana migrate semula akan seed balik bila table kosong).
"""

import frappe


def execute():
	doc = frappe.get_doc("Travel Website")

	changed = False
	if not doc.get("geo_currency_enabled"):
		doc.set("geo_currency_enabled", 1)
		changed = True

	# Seed hanya bila table kosong — jangan sentuh konfigurasi admin.
	if not doc.get("geo_currency_map"):
		for country, currency in (("Malaysia", "MYR"), ("Singapore", "SGD")):
			# Link validation — jangan gagal migrate pada site tanpa
			# rekod Country/Currency berkenaan (cth pemasangan baru
			# sebelum currency branch disediakan).
			if frappe.db.exists("Country", country) and frappe.db.exists("Currency", currency):
				doc.append("geo_currency_map", {
					"country": country,
					"currency": currency,
				})
				changed = True

	if changed:
		# on_update Travel Website kosongkan cache website_config supaya
		# mapping baharu serta-merta dipaparkan/dipakai di page awam.
		doc.save(ignore_permissions=True)
