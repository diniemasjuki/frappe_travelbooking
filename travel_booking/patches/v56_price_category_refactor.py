"""Patch v56: Trip Price Category — klasifikasi universal produk
(Nov 2026, asas PRICE MATRIX berseksyen Room/Flight/Hotel/Transport/Meal).

1. is_a_cruise (Check) → price_category (Select): 1 → 'Cruise', 0/NULL →
   'Tour'. Kolum lama digugurkan selepas salinan.
2. room_type → category_group (salinan data; kolum lama digugurkan).
3. Sample rows kategori baharu: Hotel / Transport / Meal / Flight —
   rujukan master untuk seksi PRICE MATRIX komponen (harga diisi pada
   price matrix offer/pakej, bukan pada master).

Idempoten: semakan kewujudan pada setiap langkah.
"""
import frappe

SAMPLES = [
	# (category_name, category_code, price_category, category_group,
	#  capacity, max_capacity, description)
	("Standard Room", "HS", "Hotel", "Room", 2, 3,
	 "Bilik hotel standard — katil twin/double, sesuai 2 dewasa."),
	("Deluxe Room", "HD", "Hotel", "Room", 2, 4,
	 "Bilik hotel deluxe — ruang lebih luas, pilihan katel king."),
	("Family Room", "HF", "Hotel", "Room", 4, 4,
	 "Bilik hotel keluarga — sesuai 2 dewasa + 2 kanak-kanak."),
	("Coach Seat", "TRC", "Transport", "", 1, 1,
	 "Tempat duduk bas/koc ekspres — per tempat, per penumpang."),
	("Private Van Seat", "TRV", "Transport", "", 1, 1,
	 "Tempat duduk van peribadi (6-10 penumpang) — per tempat."),
	("Half Board", "MLH", "Meal", "", 1, 1,
	 "Pakej makan separuh papan — sarapan + makan tengah hari ATAU malam."),
	("Full Board", "MLF", "Meal", "", 1, 1,
	 "Pakej makan papan penuh — sarapan + tengah hari + malam."),
	("Economy Seat", "FLE", "Flight", "", 1, 1,
	 "Tempat duduk kelas ekonomi — per tempat, per penerbangan."),
	("Business Seat", "FLB", "Flight", "", 1, 1,
	 "Tempat duduk kelas bisnes — per tempat, per penerbangan."),
]


def _has_column(table, column):
	return bool(frappe.db.sql(
		f"SHOW COLUMNS FROM `{table}` LIKE %s", (column,)))


def execute():
	table = "`tabTrip Price Category`"

	# 1) price_category daripada is_a_cruise — UPDATE TANPA syarat
	#    (is_a_cruise lebih autoritatif; DEFAULT kolum baru TIDAK
	#    dipasang supaya MariaDB tidak mengisi 'Tour' ke semua baris
	#    semasa ADD COLUMN — pelajaran dev 11 Nov 2026).
	if _has_column("tabTrip Price Category", "is_a_cruise"):
		frappe.db.sql(
			f"UPDATE {table} SET price_category = "
			f"IF(is_a_cruise = 1, 'Cruise', 'Tour')")
		frappe.db.sql_ddl(
			f"ALTER TABLE {table} DROP COLUMN is_a_cruise")
		print("v56: is_a_cruise → price_category (data dilangkung, kolum digugur)")
	else:
		# kolum lama tiada (fresh install) — pastukan terisi
		frappe.db.sql(
			f"UPDATE {table} SET price_category = 'Tour' "
			f"WHERE price_category IS NULL OR price_category = ''")

	# 2) category_group daripada room_type
	if _has_column("tabTrip Price Category", "room_type"):
		frappe.db.sql(
			f"UPDATE {table} SET category_group = room_type "
			f"WHERE (category_group IS NULL OR category_group = '') "
			f"AND room_type IS NOT NULL")
		frappe.db.sql_ddl(
			f"ALTER TABLE {table} DROP COLUMN room_type")
		print("v56: room_type → category_group (data disalin, kolum digugur)")

	# 3) Sample rows (idempoten — ikut category_code)
	added = 0
	for (name, code, pcat, group, cap, mcap, desc) in SAMPLES:
		if frappe.db.exists("Trip Price Category",
							{"category_code": code}):
			continue
		frappe.get_doc({
			"doctype": "Trip Price Category",
			"category_name": name,
			"category_code": code,
			"price_category": pcat,
			"category_group": group,
			"capacity": cap,
			"max_capacity": mcap,
			"description": desc,
		}).insert(ignore_permissions=True)
		added += 1
	frappe.db.commit()
	print(f"v56: {added} sample kategori Hotel/Transport/Meal/Flight ditambah")
