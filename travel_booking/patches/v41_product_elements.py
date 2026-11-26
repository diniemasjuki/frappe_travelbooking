"""Product Elements Restructure — patch v41.

TIGA perubahan ADDITIVE (tiada data sedia ada disentuh):

1. Trip Package Price.currency (Link → Currency) — baris harga pakej
   boleh bawa currency berbeza dari native parent (Trip Package.currency).
   KOSONG = native parent (semantic 167 baris sedia ada terpelihara).
   Membuka axis "harga per currency per kombinasi pakej": satu pakej
   boleh ada matrix MYR (native, kosong) + matrix SGD (baris bercurrency)
   per kategori bilik.

2. Item Group "Merchandise" — kategori organisasi item fizikal
   (element product merchandise), parent All Item Groups. Item bundled
   dalam pakej DAN item jualan public kedua-duanya duduk dalam group ni.

3. Custom field Item.is_public_merchandise (Check) — tandakan item
   merchandise yang dijual berasingan di laman public. Item bundled =
   Merchandise tanpa flag. Menggantikan tapisan hardcoded
   item_group='Products' (group ERPNext default yang kosong) dalam
   merchandise.get_public_merchandise.

Idempoten — selamat dijalankan berulang.
"""

import frappe


def _ensure_custom_field(spec):
	if frappe.db.exists("Custom Field", {"dt": spec["dt"], "fieldname": spec["fieldname"]}):
		return
	frappe.get_doc(dict(doctype="Custom Field", **spec)).insert(ignore_permissions=True)


def execute():
	# 1. Field currency pada baris Trip Package Price — TIDAK dicipta di
	#    sini: Frappe telah menyediakan field `currency` (Link → Currency)
	#    secara automatik pada doctype yang ada fieldtype Currency, dan
	#    column DB wujud (semua nilai kosong = native parent — semantic
	#    sedia ada terpelihara). Schema JSON doctype membawa field itu
	#    untuk paparan grid; patch hanya mengesahkan kewujudannya.
	if not frappe.get_meta("Trip Package Price").has_field("currency"):
		frappe.throw(
			"Trip Package Price.currency field missing — check doctype sync."
		)

	# 2. Item Group "Merchandise".
	if not frappe.db.exists("Item Group", "Merchandise"):
		frappe.get_doc({
			"doctype":       "Item Group",
			"item_group_name": "Merchandise",
			"parent_item_group": "All Item Groups",
			"is_group":     0,
		}).insert(ignore_permissions=True)

	# 3. Flag public pada Item.
	_ensure_custom_field({
		"dt":          "Item",
		"fieldname":   "is_public_merchandise",
		"label":       "Is Public Merchandise",
		"fieldtype":   "Check",
		"default":     "0",
		"insert_after": "item_group",
		"description": (
			"Tandakan item merchandise yang DIJUAL BERASINGAN di laman "
			"public (katalog merchandise). Item yang hanya bundled dalam "
			"pakej trip = tidak ditandakan."
		),
	})
