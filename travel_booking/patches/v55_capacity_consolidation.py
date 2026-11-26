"""Patch v55: Konsolidasi kapasiti ke kolam tunggal (Nov 2026).

1. Status operasional offer "Full" di-reset (medan/auto-job tidak lagi
   menghasilkannya; keadaan penuh dilihat pada kolam cabin_rates schedule).
2. Buang medan Package Offer.max_pax / current_pax (kolum DB) —
   jualan dikira live daripada Booking.
3. Buang Booking.offer_inventory_snapshot (mekanisme G2 ditanggalkan —
   cancel reservasi mengosongkan kuota melalui hook kiraan semula).
4. DROP doctype Sailing Inventory — kolam selari ditanggalkan; kolam
   tunggal = cabin_rates pada Trip Cruise Schedule (allotment kontrak −
   occupancy live reservasi). Baris konfigur/sold sebelum ini di-backfill
   ke cabin_rates cabin_allotment/cabin_occupancy dahulu (kuota staf
   kekal; sold = kiraan reservasi sebenar — bukan salinan kaunter).
5. Buang baris child orphan Offer Inventory / Offer Price (parenttype
   Package Offer) — medan parent telah ditanggalkan (patch v54-era).

Idempoten: setiap langkah disemak kewujudan dahulu.
"""
import frappe


def _has_column(table, column):
	return bool(frappe.db.sql(
		f"SHOW COLUMNS FROM `{table}` LIKE %s", (column,)))


def execute():
	# 1) Backfill kuota staf: Sailing Inventory.allotment → cabin_rates
	#    .cabin_allotment (hanya baris schedule yang masih ada; occupancy
	#    KEKAL kiraan reservasi — jangan salin kaunter sold lama).
	if frappe.db.table_exists("Sailing Inventory"):
		frappe.db.sql("""
			UPDATE `tabTrip Package Price` tpp
			JOIN `tabTrip Price Category` tpc
			  ON tpc.name = tpp.pricing_for_class
			JOIN `tabSailing Inventory` si
			  ON si.cruise_schedule = tpp.parent
			 AND si.inventory_key = CONCAT('cabin:', tpc.category_code)
			SET tpp.cabin_allotment = si.allotment,
			    tpp.cabin_available = si.allotment - tpp.cabin_occupancy
			WHERE tpp.parenttype = 'Trip Cruise Schedule'
			  AND si.allotment > 0
		""")
		frappe.db.commit()
		print("v55: allotment Sailing Inventory di-backfill ke cabin_rates")

	# 2) Reset status Full
	frappe.db.sql("""
		UPDATE `tabPackage Offer`
		SET status_operational = 'Scheduled'
		WHERE status_operational = 'Full'
	""")

	# 3) Buang baris child orphan (medan parent sudah ditanggalkan)
	for doctype in ("Offer Inventory", "Offer Price"):
		n = frappe.db.count(doctype, {"parenttype": "Package Offer"})
		if n:
			frappe.db.sql(
				f"DELETE FROM `tab{doctype}` WHERE parenttype = 'Package Offer'",
			)
			print(f"v55: {n} baris orphan {doctype} dipadam")

	# 4) Buang kolum medan yang ditanggalkan
	for table, col in (
		("tabPackage Offer", "max_pax"),
		("tabPackage Offer", "current_pax"),
		("tabBooking", "offer_inventory_snapshot"),
	):
		if _has_column(table, col):
			frappe.db.sql_ddl(f"ALTER TABLE `{table}` DROP COLUMN `{col}`")
			print(f"v55: kolum {table}.{col} digugurkan")

	frappe.db.commit()

	# 5) DROP doctype Sailing Inventory (dengan jadualnya)
	if frappe.db.exists("DocType", "Sailing Inventory"):
		frappe.delete_doc("DocType", "Sailing Inventory",
						  force=1, ignore_permissions=True)
		print("v55: doctype Sailing Inventory dipadam")

	frappe.db.commit()
	print("v55: konsolidasi kapasiti selesai")
