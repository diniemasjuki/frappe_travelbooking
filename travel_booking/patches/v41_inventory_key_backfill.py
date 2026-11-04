"""Patch v41: backfill F3 — public_slug Travel Package + inventory_key
Booking Reservation (dari Room Category).

IDEMPOTENT: hanya isi medan KOSONG (fill-empty-only, update_modified=False
— tiada side-effect hook). Selamat untuk production.
"""
import frappe


def execute():
	# 1. public_slug untuk pakej yang belum ada
	slugs = 0
	for name in frappe.get_all(
		"Travel Package", filters={"public_slug": ["is", "not set"]}, pluck="name"
	):
		frappe.db.set_value(
			"Travel Package", name,
			"public_slug", frappe.generate_hash(length=16),
			update_modified=False,
		)
		slugs += 1
	print(f"v41: {slugs} public_slug dijana")

	# 2. inventory_key untuk reservasi berkategori yang masih kosong
	total = 0
	while True:
		rows = frappe.db.sql(
			"""
			SELECT br.name AS res, COALESCE(tp.category_code, tp.name) AS code
			FROM `tabBooking Reservation` br
			INNER JOIN `tabTrip Price Category` tp ON tp.name = br.room_category
			WHERE (br.inventory_key IS NULL OR br.inventory_key = '')
			LIMIT 5000
			""",
			as_dict=True,
		)
		if not rows:
			break
		for r in rows:
			frappe.db.set_value(
				"Booking Reservation", r.res,
				"inventory_key", "cabin:" + r.code,
				update_modified=False,
			)
			total += 1
	print(f"v41: {total} inventory_key di-backfill")
