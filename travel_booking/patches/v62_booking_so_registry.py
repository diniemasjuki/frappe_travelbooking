"""Patch v62: Registri Booking.sales_orders menggantikan SO.custom_booking.

[Nov 2026] Arah rujukan SO↔Booking dibalikkan: Booking memiliki senarai
SO-nya melalui child table "Booking Sales Order" (field Booking.
sales_orders); Sales Order TIDAK lagi memegang link custom_booking ke
Booking. Matlamat: SO bebas daripada sekatan link dua-hala (cancel/delete
mudah), dan split billing / upgrade SO jadi operasi registri yang jelas.

Langkah (idempoten):
  1. Backfill — setiap SO dengan custom_booking → baris registri pada
     Booking berkenaan (ikut creation SO supaya "primary" = SO terawal,
     mengekalkan semantik _get_primary_so sedia ada).
  2. Kosongkan nilai so.custom_booking (semua row — link check Frappe
     abaikan NULL, jadi pemadaman Booking/SO tidak lagi tersekat).
     Custom Field TIDAK dipadam: kolum legacy disembunyikan & dikekalkan
     supaya patch lama (v8/v19/v28/v61) kekal selamat pada install baru.
"""
import frappe


def execute():
	# 1) Backfill registri — guard kolum (jalanan kedua: kolum dah tiada)
	if not bool(frappe.db.sql(
			"SHOW COLUMNS FROM `tabSales Order` LIKE 'custom_booking'")):
		print("v62 booking-so registry: kolum custom_booking tiada — skip")
		return
	rows = frappe.db.sql("""
		SELECT so.name AS so, so.custom_booking AS booking, so.currency, so.creation
		FROM `tabSales Order` so
		WHERE so.custom_booking IS NOT NULL AND so.custom_booking != ''
		ORDER BY so.creation ASC
	""", as_dict=True)

	existing = {
		(r.parent, r.sales_order)
		for r in frappe.db.get_all("Booking Sales Order",
			filters={"parenttype": "Booking"},
			fields=["parent", "sales_order"])
	}

	count = 0
	for r in rows:
		if (r.booking, r.so) in existing:
			continue
		if not frappe.db.exists("Booking", r.booking):
			continue  # SO yatim (booking dipadam tanpa cleanup) — buang
		idx = frappe.db.count("Booking Sales Order",
			{"parent": r.booking, "parenttype": "Booking"}) + 1
		frappe.get_doc({
			"doctype": "Booking Sales Order",
			"parent": r.booking,
			"parentfield": "sales_orders",
			"parenttype": "Booking",
			"idx": idx,
			"sales_order": r.so,
			"purpose": "Main Booking",
			"currency": r.currency,
		}).insert(ignore_permissions=True)
		count += 1

	frappe.db.commit()

	# 2) Kosongkan nilai — idempoten: semak kewujudan kolum dahulu.
	# Custom Field TIDAK dipadam: kolum dikekalkan (tersembunyi, nilai
	# NULL) supaya patch lama (v8/v19/v28/v61 — query kolum ni) kekal
	# selamat pada pemasangan site baru. Link check Frappe abaikan NULL —
	# pemadaman Booking/SO tidak lagi tersekat.
	has_col = bool(frappe.db.sql(
		"SHOW COLUMNS FROM `tabSales Order` LIKE 'custom_booking'"))
	if has_col:
		frappe.db.sql(
			"UPDATE `tabSales Order` SET custom_booking = NULL "
			"WHERE custom_booking IS NOT NULL")

	frappe.db.commit()
	print(f"v62 booking-so registry: {count} baris backfill; custom_booking dikosongkan (kolum legacy kekal)")
