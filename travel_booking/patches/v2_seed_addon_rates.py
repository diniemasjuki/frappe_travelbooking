"""Seed baris pertama Currency Rates pada setiap Trip Addon Package
daripada harga legacy (currency + unit_price) — behavior hari ini
kekal untuk addon dalam currency default.

Model multi-currency baharu: harga jualan addon datang dari child table
'Trip Addon Package Rate' (currency + unit_price per baris). Patch ni
memastikan peralihan tanpa kehilangan harga:

- Pakej yang TIADA baris rate → cipta SATU baris (currency legacy,
  unit_price legacy, enabled=1).
- Pakej yang DAH ada baris rate → tidak disentuh (idempotent).

Baris rate currency lain (SGD/IDR/...) admin tambah sendiri di Desk
selepas currency tersebut diisytiharkan dalam Travel Settings.
"""

import frappe

from frappe.model.naming import append_number_if_name_exists


def execute():
	packages = frappe.db.sql(
		"""
		SELECT ap.name, ap.currency, ap.unit_price,
		       (SELECT COUNT(*) FROM `tabTrip Addon Package Rate` r
		        WHERE r.parent = ap.name AND r.parenttype = 'Trip Addon Package') AS rate_count
		FROM `tabTrip Addon Package` ap
		""",
		as_dict=True,
	)

	for p in packages:
		if p.rate_count:
			continue
		if not p.currency:
			continue  # tiada currency legacy untuk seed — biar kosong (fallback admin)

		# Insert baris child terus (bukan load/save doc penuh) — elak trigger
		# semula seluruh validate() pakej (set_currency_and_unit_price akan
		# overwrite unit_price legacy dari Trip Addon yang mungkin tiada
		# base_price lagi). Child table ringkas — kolom standard cukup.
		row_name = append_number_if_name_exists("Trip Addon Package Rate", "rate-" + frappe.generate_hash(length=8))
		frappe.db.sql(
			"""
			INSERT INTO `tabTrip Addon Package Rate`
			(name, creation, modified, modified_by, owner, parent, parentfield,
			 parenttype, idx, currency, unit_price, enabled)
			VALUES (%s, NOW(), NOW(), %s, %s, %s, 'currency_rates',
			 'Trip Addon Package', 1, %s, %s, 1)
			""",
			(row_name, frappe.session.user, frappe.session.user,
			 p.name, p.currency, float(p.unit_price or 0)),
		)
