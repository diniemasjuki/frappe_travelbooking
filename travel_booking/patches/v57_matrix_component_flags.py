"""Patch v57: Flag seksi PRICE MATRIX aktif pada Package Offer (Nov 2026).

Default (keputusan pemilik — derive daripada baris sedia ada):
  - matrix_room = 1 utk SEMUA offer (harga asas, terkunci).
  - matrix_flight/hotel/transport/meal = 1 HANYA bila offer itu sudah
    mempunyai baris price_matrix kategori price_category tersebut.

Keadaan sedia ada terpelihara tepat — tiada tab yang hilang, tiada tab
kosong yang tiba-tiba muncul. Offer baharu (json default): room=1, lain=0.
"""
import frappe

_COMPONENT_FLAG = (
	("Flight", "matrix_flight"),
	("Hotel", "matrix_hotel"),
	("Transport", "matrix_transport"),
	("Meal", "matrix_meal"),
)


def execute():
	frappe.db.sql("UPDATE `tabPackage Offer` SET matrix_room = 1")
	for comp, flag in _COMPONENT_FLAG:
		frappe.db.sql(f"""
			UPDATE `tabPackage Offer` o
			SET o.{flag} = 1
			WHERE EXISTS (
				SELECT 1 FROM `tabTrip Package Price` tpp
				JOIN `tabTrip Price Category` tpc
				  ON tpc.name = tpp.pricing_for_class
				WHERE tpp.parent = o.name
				  AND tpp.parenttype = 'Package Offer'
				  AND tpc.price_category = %s
			)
		""", comp)
	frappe.db.commit()
	n = frappe.db.sql("""
		SELECT SUM(matrix_flight), SUM(matrix_hotel),
		       SUM(matrix_transport), SUM(matrix_meal)
		FROM `tabPackage Offer`
	""")[0]
	print(f"v57: matrix flags derive — flight={n[0]} hotel={n[1]} "
		  f"transport={n[2]} meal={n[3]}")
