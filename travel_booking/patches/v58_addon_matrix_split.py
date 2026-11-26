"""Patch v58: Rombakan konsep matrix (Nov 2026) — pisahkan BASE daripada
ADDONS pada Package Offer.

Room Category = BASE PRICE (kekalkan parentfield `price_matrix`);
Flight/Hotel/Transport/Meal = ADDONS → dialihkan ke parentfield
`addon_price_matrix` (child Trip Package Price yang sama, table berasingan).

Total pakej = base (kategori dipilih × slot) + Σ addons.
Idempoten: hanya baris price_matrix dengan kategori addon dipindahkan.
"""
import frappe


def execute():
	moved = frappe.db.sql("""
		UPDATE `tabTrip Package Price` tpp
		JOIN `tabTrip Price Category` tpc
		  ON tpc.name = tpp.pricing_for_class
		SET tpp.parentfield = 'addon_price_matrix'
		WHERE tpp.parenttype = 'Package Offer'
		  AND tpp.parentfield = 'price_matrix'
		  AND tpc.price_category IN ('Flight', 'Hotel', 'Transport', 'Meal')
	""")
	frappe.db.commit()
	n = frappe.db.sql("""
		SELECT COUNT(*) FROM `tabTrip Package Price`
		WHERE parenttype = 'Package Offer'
		  AND parentfield = 'addon_price_matrix'
	""")[0][0]
	print(f"v58: baris addon dipindah ke addon_price_matrix (jumlah kini: {n})")
