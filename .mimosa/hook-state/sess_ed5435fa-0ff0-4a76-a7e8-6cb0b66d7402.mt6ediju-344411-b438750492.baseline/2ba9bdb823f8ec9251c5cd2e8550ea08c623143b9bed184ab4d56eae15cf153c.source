"""Tambah custom field rc_display_currency pada Customer doctype.

Simpan pilihan display currency customer (portal converter) supaya
preference kekal across devices/browsers — bukan cuma localStorage
per-browser. Field ini Link ke Currency; kosong = tiada preference
(pakai company currency).

Converter sentiasa display-only: semua cas dalam company currency.
Field ini cuma tentukan currency mana yang dipaparkan bersama amaun
company currency (cth "SGD 1,234.00 (RM 3,850.00)").
"""

import frappe


def execute():
	# Idempoten — skip kalau field dah wujud.
	if frappe.db.exists(
		"Custom Field", {"dt": "Customer", "fieldname": "rc_display_currency"}
	):
		return

	frappe.get_doc(
		{
			"doctype": "Custom Field",
			"dt": "Customer",
			"fieldname": "rc_display_currency",
			"label": "Display Currency Preference",
			"fieldtype": "Link",
			"options": "Currency",
			"insert_after": "customer_group",
			"description": (
				"Preferred display currency for the portal currency converter "
				"(display-only; charges are always in company currency)."
			),
			"no_copy": 1,
			"print_hide": 1,
		}
	).insert(ignore_permissions=True)
