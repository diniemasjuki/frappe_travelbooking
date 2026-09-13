"""Tambah Sales Order.custom_voucher_discount & custom_referral_discount —
jumlah diskaun order-level voucher/referral (dalam currency SO).

Latar belakang (refactor diskaun → Payment Entry deduction):
Dahulu, diskaun voucher & referral dilaksanakan sebagai BARIS ITEM
RATE NEGATIF pada SO ("Voucher Discount (X)" / "Referral Discount (Y)")
— SO grand_total sudah NET diskaun. ERPNext menolak baris rate negatif
melainkan Selling Settings > Allow Negative rates for items dihidupkan,
jadi booking bervoucher gagal 417 di site yang setting-nya tutup.

Kini: SO KEKAL GROSS (semua baris item rate positif). Jumlah diskaun
disimpan pada SO sendiri (dua field ni) supaya SETIAP pencipta Payment
Entry boleh menyerapnya sebagai DEDUCTION (debit) ke akaun Marketing
Expenses company tersebut — corak yang sama dengan cashback Manual
Transfer (custom_cashback_percent):

  - confirm_booking() → _create_manual_payment_entry() (wizard Manual
    Transfer) — deduction terus pada PE pertama.
  - submit_manual_payment() (portal) — menyerap BAKI diskaun yang
    belum diserap PE terdahulu (rujuk _get_absorbed_order_discount()).
  - _mark_payment_request_paid() (Stripe webhook/fallback) — PE ERPNext
    allocate cash net sahaja, jadi baki diskaun diselesaikan dengan
    Payment Entry pelengkap (rujuk _create_discount_settlement_entry()).

0/kosong = tiada diskaun (termasuk semua SO lama yang membawa baris
rate negatif — behavior lama dikekalkan untuk data sedia ada).
"""

import frappe


def _ensure_custom_field(spec):
	"""Idempoten per-field — selamat dipanggil berulang."""
	if frappe.db.exists("Custom Field", {"dt": spec["dt"], "fieldname": spec["fieldname"]}):
		return
	frappe.get_doc(dict(doctype="Custom Field", **spec)).insert(ignore_permissions=True)


def execute():
	common = {
		"dt":              "Sales Order",
		"fieldtype":       "Currency",
		"insert_after":    "custom_cashback_percent",
		"print_hide":      1,
		"read_only":       1,
		"allow_on_submit": 1,
		"no_copy":         1,
	}
	_ensure_custom_field({**common, **{
		"fieldname":    "custom_voucher_discount",
		"label":        "Voucher Discount Amount",
		"description": (
			"Total voucher discount for this order (in SO currency), absorbed "
			"as a Payment Entry deduction (debit) to the company's Marketing "
			"Expenses account. Set by the booking wizard. 0 = no voucher."
		),
	}})
	_ensure_custom_field({**common, **{
		"fieldname":    "custom_referral_discount",
		"label":        "Referral Discount Amount",
		"description": (
			"Total referral/affiliate discount for this order (in SO currency), "
			"absorbed as a Payment Entry deduction (debit) to the company's "
			"Marketing Expenses account. Set by the booking wizard. 0 = none."
		),
	}})
