"""Tambah Sales Order.custom_cashback_percent — penanda cashback Manual
Transfer pada peringkat SO.

Latar belakang (refactor cashback → Payment Entry deduction):
Sebelum ni, cashback Manual Transfer dilaksanakan sebagai Additional
Discount pada SO (additional_discount_percentage = cashback_percent) —
SO grand_total sudah NET cashback, jadi Payment Entry bayaran manual
menerima & allocate jumlah net, dan nilai cashback TIDAK pernah muncul
dalam Payment Entry. Expense cashback hanya terpost ke akaun diskaun
masa Sales Invoice dijana.

Kini: cashback dicatat terus dalam Payment Entry manual sebagai baris
DEDUCTION (debit) pada akaun Marketing Expenses company tersebut. Supaya
PE kekal seimbang (ERPNext: received + deductions = allocated), SO
KEKAL GROSS — jadi peratus cashback perlu disimpan pada SO sendiri
(field ni) sebagai penanda kelayakan untuk bayaran baki melalui portal
(submit_manual_payment), kerana SO tidak lagi membawa additional
discount cashback.

0/kosong = bukan booking cashback (termasuk semua SO lama — behavior
lama dikekalkan untuk data sedia ada).
"""

import frappe


def _ensure_custom_field(spec):
	"""Idempoten per-field — selamat dipanggil berulang."""
	if frappe.db.exists("Custom Field", {"dt": spec["dt"], "fieldname": spec["fieldname"]}):
		return
	frappe.get_doc(dict(doctype="Custom Field", **spec)).insert(ignore_permissions=True)


def execute():
	_ensure_custom_field({
		"dt":              "Sales Order",
		"fieldname":       "custom_cashback_percent",
		"label":           "Manual Transfer Cashback Percent",
		"fieldtype":       "Percent",
		"insert_after":    "custom_booking",
		"description": (
			"Cashback percent applied per Payment Entry (deduction to the "
			"company's Marketing Expenses account) for Manual Transfer "
			"payments against this Sales Order. Set by the booking wizard "
			"when Travel Settings cashback is enabled. 0 = not eligible."
		),
		"print_hide":      1,
		"read_only":       1,
		"allow_on_submit": 1,
		"no_copy":         1,
	})
